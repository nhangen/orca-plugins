import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { parseGitRemote, parseGitBranches } from './worker'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Real directories, because the worker filters candidates by path existence. */
function withTempWorkspaces(names: string[], run: (paths: string[]) => Promise<void>): () => Promise<void> {
  return async () => {
    const paths = names.map((name) => mkdtempSync(join(tmpdir(), `${name}-`)))
    try {
      await run(paths)
    } finally {
      paths.forEach((p) => rmSync(p, { recursive: true, force: true }))
    }
  }
}

const baseHost = (workspaces: unknown[], options: Record<string, unknown> = {}): Object =>
  mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
      'workspace.list': { workspaces, truncated: false },
      ...options
    }
  })

test('parseGitRemote parses SSH and HTTPS GitHub urls', () => {
  assert.equal(parseGitRemote('git@github.com:owner/repo.git'), 'owner/repo')
  assert.equal(parseGitRemote('git@github-nhangen:owner/repo.git'), 'owner/repo')
  assert.equal(parseGitRemote('https://github.com/owner/repo.git'), 'owner/repo')
  assert.equal(parseGitRemote('https://github.com/owner/repo'), 'owner/repo')
  assert.equal(parseGitRemote('not-a-repo'), null)
  assert.equal(parseGitRemote('git@github.com:owner/.github.git'), 'owner/.github')
  assert.equal(parseGitRemote('https://github.com/../..'), null)
  assert.equal(parseGitRemote('git@github.com:owner/..'), null)
  assert.equal(parseGitRemote('git@github.com:./repo.git'), null)
})

test('parseGitBranches parses git branch output correctly', () => {
  const raw = `
main| |origin/main|Merge PR|2026-11-08
feature/xyz|*|origin/feature/xyz|Work in progress|2026-11-10
`
  const result = parseGitBranches(raw)
  assert.equal(result.currentBranch, 'feature/xyz')
  assert.equal(result.branches.length, 2)
  assert.equal(result.branches[0].name, 'main')
  assert.equal(result.branches[0].isHead, false)
  assert.equal(result.branches[1].name, 'feature/xyz')
  assert.equal(result.branches[1].isHead, true)
})

test('worker registers repo.getContext handler and answers requests', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'my-project', terminals: [] },
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'folder', name: 'my-project', path: process.cwd(), branch: 'main', hostId: null }
        ],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  const result = (await worker.request('repo.getContext')) as any
  assert.ok(result)
  assert.ok(Array.isArray(result.branches))
  assert.ok(Array.isArray(result.issues))
  assert.ok(Array.isArray(result.pullRequests))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('worker picks the folder workspace when its branch is null and a sibling worktree is listed first', withTempWorkspaces(
  ['my-project.wt', 'my-project'],
  async ([worktreePath, folderPath]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'my-project', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'draft', path: worktreePath, branch: 'refs/heads/draft', hostId: null },
            { id: 'w1', kind: 'folder', name: 'my-project', path: folderPath, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, folderPath)
    assert.ok(!result.ambiguous)
    await worker.deactivate()
  }
))

test('worker reports ambiguous candidates and persists a pick when several workspaces share the focused branch', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = baseHost([entry(alice), entry(bob)]) as any
    const worker = await mountWorker(main, { host })
    const context = (await worker.request('repo.getContext')) as any
    assert.ok(context.ambiguous)
    assert.equal(context.candidates.length, 2)
    assert.equal(context.workspacePath, alice)
    const chosen = (await worker.request('repo.chooseWorkspace', { path: bob })) as any
    assert.ok(chosen.ambiguous)
    assert.deepEqual(host.data().storage.workspaceChoices, { 'main|main': bob })
    assert.equal(chosen.workspacePath, bob)
    await worker.deactivate()
  }
))

test('worker honors a stored workspace pick on a fresh worker', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      storage: { workspaceChoices: { 'main|main': bob } },
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
        'workspace.list': { workspaces: [entry(alice), entry(bob)], truncated: false }
      }
    })
    const worker = await mountWorker(main, { host })
    const context = (await worker.request('repo.getContext')) as any
    assert.equal(context.workspacePath, bob)
    await worker.deactivate()
  }
))

test('worker falls back to the first candidate and prunes a pick whose path no longer exists', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      storage: { workspaceChoices: { 'main|main': '/gone/missing' } },
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
        'workspace.list': { workspaces: [entry(alice), entry(bob)], truncated: false }
      }
    })
    const worker = await mountWorker(main, { host })
    const context = (await worker.request('repo.getContext')) as any
    assert.ok(context.ambiguous)
    assert.equal(context.workspacePath, alice)
    assert.deepEqual(host.data().storage.workspaceChoices, {})
    await worker.deactivate()
  }
))

test('worker excludes non-local candidates and ignores invalid chooseWorkspace input', withTempWorkspaces(
  ['wb-local'],
  async ([local]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = baseHost([entry(local), entry('/remote-host/main')]) as any
    const worker = await mountWorker(main, { host })
    const context = (await worker.request('repo.getContext')) as any
    assert.ok(!context.ambiguous)
    assert.equal(context.workspacePath, local)
    const rejected = (await worker.request('repo.chooseWorkspace', { path: '/gone/missing' })) as any
    assert.ok(!rejected.ambiguous)
    assert.deepEqual(host.data().storage.workspaceChoices ?? undefined, undefined)
    await worker.deactivate()
  }
))

test('a pick keeps the picks stored for other branch and name keys', withTempWorkspaces(
  ['wb-alice', 'wb-bob', 'wb-dev'],
  async ([alice, bob, dev]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      storage: { workspaceChoices: { 'develop|develop': dev } },
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
        'workspace.list': { workspaces: [entry(alice), entry(bob)], truncated: false }
      }
    })
    const worker = await mountWorker(main, { host })
    await worker.request('repo.chooseWorkspace', { path: bob })
    assert.deepEqual(host.data().storage.workspaceChoices, { 'develop|develop': dev, 'main|main': bob })
    await worker.deactivate()
  }
))

test('a pick still applies for the session when storage refuses the write', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      storage: { workspaceChoices: { 'main|main': alice } },
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
        'workspace.list': { workspaces: [entry(alice), entry(bob)], truncated: false },
        'storage.set': () => {
          throw hostError('action_failed', 'disk full')
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const chosen = (await worker.request('repo.chooseWorkspace', { path: bob })) as any
    assert.equal(chosen.workspacePath, bob)
    const again = (await worker.request('repo.getContext')) as any
    assert.equal(again.workspacePath, bob)
    await worker.deactivate()
  }
))

test('a pick made in one worker does not leak into a freshly mounted one', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const first = await mountWorker(main, { host: baseHost([entry(alice), entry(bob)]) as any })
    await first.request('repo.chooseWorkspace', { path: bob })
    await first.deactivate()
    const second = await mountWorker(main, { host: baseHost([entry(alice), entry(bob)]) as any })
    const context = (await second.request('repo.getContext')) as any
    assert.equal(context.workspacePath, alice)
    await second.deactivate()
  }
))

test('chooseWorkspace refuses an existing path that is not one of the current candidates', withTempWorkspaces(
  ['wb-alice', 'wb-bob', 'wb-outsider'],
  async ([alice, bob, outsider]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = baseHost([entry(alice), entry(bob)]) as any
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.chooseWorkspace', { path: outsider })) as any
    assert.equal(result.workspacePath, alice)
    assert.equal(host.data().storage.workspaceChoices, undefined)
    await worker.deactivate()
  }
))

test('a slow collect for an earlier focus is not posted after a newer one', withTempWorkspaces(
  ['wb-a', 'wb-b'],
  async ([a, b]) => {
    let focus = 'a'
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      results: {
        'workspace.readContext': () => ({ branch: focus, displayName: focus, terminals: [] }),
        'workspace.list': {
          workspaces: [
            { id: 'wa', kind: 'worktree', name: 'a', path: a, branch: 'a', hostId: null },
            { id: 'wb', kind: 'worktree', name: 'b', path: b, branch: 'b', hostId: null }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    await worker.request('repo.getContext')
    const before = worker.posts.length
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reachedPublish: () => void = () => {}
    const slowAtPublish = new Promise<void>((resolve) => {
      reachedPublish = resolve
    })
    main.testHooks.beforePublish = async (context) => {
      if (context.workspacePath === a) {
        reachedPublish()
        await held
      }
    }
    const realNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      const slow = worker.request('repo.getContext')
      await slowAtPublish
      focus = 'b'
      await worker.emit('workspace.changed', { context: { branch: 'b', displayName: 'b', terminals: [] } })
      release()
      await slow
    } finally {
      Date.now = realNow
      main.testHooks.beforePublish = null
    }
    assert.equal((host.data().storage.latestContext as any).workspacePath, b)
    const posted = worker.posts.slice(before).filter((p) => p.event === 'repo.changed').map((p) => (p.payload as any).workspacePath)
    assert.deepEqual(posted, [b])
    await worker.deactivate()
  }
))

test('a uniquely named folder workspace beats an unrelated clone on the focused branch', withTempWorkspaces(
  ['my-project', 'other-clone'],
  async ([folder, clone]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'my-project', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'main', path: clone, branch: 'main', hostId: null },
            { id: 'w1', kind: 'folder', name: 'my-project', path: folder, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, folder)
    assert.ok(!result.ambiguous)
    await worker.deactivate()
  }
))

test('with no match the folder workspace is the default among the flagged candidates', withTempWorkspaces(
  ['wb-wt', 'wb-folder'],
  async ([wt, folder]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      results: {
        'workspace.readContext': { branch: 'release', displayName: 'release', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'main', path: wt, branch: 'main', hostId: null },
            { id: 'w1', kind: 'folder', name: 'notes', path: folder, branch: null, hostId: null }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.ok(result.ambiguous)
    assert.equal(result.workspacePath, folder)
    await worker.deactivate()
  }
))

test('a prune that read storage before a pick does not erase the pick', withTempWorkspaces(
  ['wb-alice', 'wb-bob', 'wb-retired'],
  async ([alice, bob, retired]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      storage: { workspaceChoices: { 'old|old': retired } },
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
        'workspace.list': { workspaces: [entry(alice), entry(bob)], truncated: false }
      }
    })
    const worker = await mountWorker(main, { host })
    await worker.request('repo.getContext')
    rmSync(retired, { recursive: true, force: true })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached: () => void = () => {}
    const pruneRead = new Promise<void>((resolve) => {
      reached = resolve
    })
    let first = true
    main.testHooks.afterChoicesRead = async () => {
      if (first) {
        first = false
        reached()
        await held
      }
    }
    try {
      const pruning = worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'main', terminals: [] } })
      await pruneRead
      const picking = worker.request('repo.chooseWorkspace', { path: bob })
      await new Promise((resolve) => setTimeout(resolve, 20))
      release()
      await pruning
      await picking
    } finally {
      main.testHooks.afterChoicesRead = null
    }
    assert.deepEqual(host.data().storage.workspaceChoices, { 'main|main': bob })
    await worker.deactivate()
  }
))

test('a context with no local workspace reports it instead of running git elsewhere', async () => {
  const host = baseHost([
    { id: 'w0', kind: 'worktree', name: 'main', path: '/remote/a', branch: 'main', hostId: 'ssh-buildbox' }
  ]) as any
  const worker = await mountWorker(main, { host })
  const result = (await worker.request('repo.getContext')) as any
  assert.equal(result.workspacePath, null)
  assert.equal(result.repoSlug, null)
  assert.match(result.branchesError, /No local workspace/)
  await worker.deactivate()
})

test('labels stay distinct when the last two folders also match', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-deep-'))
  const a = join(root, 'a', 'code', 'foo')
  const b = join(root, 'b', 'code', 'foo')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  try {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const worker = await mountWorker(main, { host: baseHost([entry(a), entry(b)]) as any })
    const result = (await worker.request('repo.getContext')) as any
    assert.deepEqual(result.candidates.map((c: any) => c.name), ['a/code/foo', 'b/code/foo'])
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker prefers a worktree whose branch matches the focused branch', withTempWorkspaces(
  ['my-project', 'my-project.wt'],
  async ([folderPath, worktreePath]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      results: {
        'workspace.readContext': { branch: 'draft', displayName: 'draft', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'w1', kind: 'folder', name: 'my-project', path: folderPath, branch: null, hostId: null },
            { id: 'w0', kind: 'worktree', name: 'draft', path: worktreePath, branch: 'refs/heads/draft', hostId: null }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, worktreePath)
    await worker.deactivate()
  }
))

test('a renamed workspace on a shared branch resolves to itself without a picker', withTempWorkspaces(
  ['wb-ceo', 'wb-tools'],
  async ([ceo, tools]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'ceo', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'main', path: tools, branch: 'main', hostId: null },
            { id: 'w1', kind: 'worktree', name: 'ceo', path: ceo, branch: 'main', hostId: null }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, ceo)
    assert.ok(!result.ambiguous)
    await worker.deactivate()
  }
))

test('a remote workspace whose path also exists locally is not a candidate', withTempWorkspaces(
  ['wb-local', 'wb-mirrored'],
  async ([local, mirrored]) => {
    const host = baseHost([
      { id: 'w0', kind: 'worktree', name: 'main', path: mirrored, branch: 'main', hostId: 'ssh-buildbox' },
      { id: 'w1', kind: 'worktree', name: 'main', path: local, branch: 'main', hostId: 'local' }
    ]) as any
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, local)
    assert.ok(!result.ambiguous)
    await worker.deactivate()
  }
))

test('remote-only matches never become the repo the worker runs git in', async () => {
  const host = baseHost([
    { id: 'w0', kind: 'worktree', name: 'main', path: '/remote/a', branch: 'main', hostId: 'ssh-buildbox' },
    { id: 'w1', kind: 'worktree', name: 'main', path: '/remote/b', branch: 'main', hostId: 'ssh-buildbox' }
  ]) as any
  const worker = await mountWorker(main, { host })
  const result = (await worker.request('repo.getContext')) as any
  assert.equal(result.workspacePath, null)
  assert.ok(!result.ambiguous)
  assert.equal(result.candidates, undefined)
  await worker.deactivate()
})

test('no workspace matching the focused branch or name is flagged rather than guessed', withTempWorkspaces(
  ['wb-one', 'wb-two'],
  async ([one, two]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      results: {
        'workspace.readContext': { branch: 'release', displayName: 'release', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'main', path: one, branch: 'main', hostId: null },
            { id: 'w1', kind: 'worktree', name: 'dev', path: two, branch: 'dev', hostId: null }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.ok(result.ambiguous)
    assert.deepEqual(result.candidates.map((c: any) => c.path), [one, two])
    await worker.deactivate()
  }
))

test('candidates that share a folder name are labelled with their parent folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-labels-'))
  const a = join(root, 'code', 'foo')
  const b = join(root, 'work', 'foo')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  try {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const worker = await mountWorker(main, { host: baseHost([entry(a), entry(b)]) as any })
    const result = (await worker.request('repo.getContext')) as any
    assert.deepEqual(result.candidates.map((c: any) => c.name), ['code/foo', 'work/foo'])
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
