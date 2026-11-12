import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { parseGitRemote, parseGitBranches, extractProjectFromTitle } from './worker'
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

main.testHooks.cloneRoots = []

const baseHost = (workspaces: unknown[], options: Record<string, unknown> = {}): Object =>
  mockHost({
    capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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
    capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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

test('a failed pick write does not block the writes queued after it', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const store: Record<string, any> = { workspaceChoices: { 'dev|dev': join(tmpdir(), 'wb-never-existed') } }
    let choiceWrites = 0
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
        'workspace.list': { workspaces: [entry(alice), entry(bob)], truncated: false },
        'storage.get': ({ key }: { key: string }) => ({ value: store[key] ?? null }),
        'storage.set': ({ key, value }: { key: string; value: any }) => {
          if (key === 'workspaceChoices' && choiceWrites++ === 0) throw hostError('action_failed', 'disk full')
          store[key] = value
          return { ok: true }
        }
      }
    })
    const worker = await mountWorker(main, { host })
    await worker.request('repo.getContext')
    await worker.request('repo.chooseWorkspace', { path: bob })
    assert.equal(store.workspaceChoices['main|main'], bob)
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
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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

test('with no match a folder workspace is not guessed either', withTempWorkspaces(
  ['wb-wt', 'wb-folder'],
  async ([wt, folder]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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
    assert.equal(result.workspacePath, null)
    assert.ok(!result.ambiguous)
    assert.equal(result.branchesError, 'No local workspace matches the focused workspace')
    await worker.deactivate()
  }
))

test('a prune that read storage before a pick does not erase the pick', withTempWorkspaces(
  ['wb-alice', 'wb-bob', 'wb-retired'],
  async ([alice, bob, retired]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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

test('a failed workspace read is reported as itself, not as a missing workspace', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read', 'agent:read'],
    results: {
      'workspace.readContext': () => {
        throw hostError('action_failed', 'host unavailable')
      },
      'workspace.list': { workspaces: [], truncated: false }
    }
  })
  const worker = await mountWorker(main, { host })
  const result = (await worker.request('repo.getContext')) as any
  assert.equal(result.workspacePath, null)
  assert.match(result.branchesError, /host unavailable/)
  assert.match(result.issuesError, /host unavailable/)
  await worker.deactivate()
})

test('a learned agent terminal identifies the focused workspace without a picker', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string, id: string) => ({ id, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [{ id: 'term-bob' }] },
        'workspace.list': { workspaces: [entry(alice, 'w-alice'), entry(bob, 'w-bob')], truncated: false }
      }
    })
    const worker = await mountWorker(main, { host })
    const before = (await worker.request('repo.getContext')) as any
    assert.ok(before.ambiguous)
    await worker.emit('agent.status.changed', { workspaceId: 'w-bob', terminalId: 'term-bob', paneKey: 'p1', state: 'working', receivedAt: 1 })
    const after = (await worker.request('repo.getContext')) as any
    assert.ok(!after.ambiguous)
    assert.equal(after.workspacePath, bob)
    assert.deepEqual(host.data().storage.workspaceChoices, undefined)
    await worker.deactivate()
  }
))

test('learned terminal owners are bounded, oldest first', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string, id: string) => ({ id, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [{ id: 'term-bob' }] },
        'workspace.list': { workspaces: [entry(alice, 'w-alice'), entry(bob, 'w-bob')], truncated: false }
      }
    })
    const worker = await mountWorker(main, { host })
    await worker.emit('agent.status.changed', { workspaceId: 'w-bob', terminalId: 'term-bob', paneKey: 'p1', state: 'working', receivedAt: 1 })
    assert.equal(((await worker.request('repo.getContext')) as any).workspacePath, bob)
    for (let i = 0; i < 100; i++) {
      await worker.emit('agent.status.changed', { workspaceId: 'w-alice', terminalId: `term-${i}`, paneKey: `p${i}`, state: 'working', receivedAt: 2 + i })
    }
    assert.ok(((await worker.request('repo.getContext')) as any).ambiguous)
    await worker.deactivate()
  }
))

test('a terminal owned by a workspace outside the branch+name matches is ignored', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string, id: string) => ({ id, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [{ id: 'term-x' }] },
        'workspace.list': {
          workspaces: [entry(alice, 'w-alice'), entry(bob, 'w-bob'), { id: 'w-x', kind: 'worktree', name: 'dev', path: '/remote/dev', branch: 'dev', hostId: 'ssh-box' }],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    await worker.emit('agent.status.changed', { workspaceId: 'w-x', terminalId: 'term-x', paneKey: 'p1', state: 'working', receivedAt: 1 })
    const context = (await worker.request('repo.getContext')) as any
    assert.ok(context.ambiguous)
    assert.equal(context.workspacePath, alice)
    await worker.deactivate()
  }
))

test('a focused terminal Orca never tied to a workspace leaves the picker in place', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string, id: string) => ({ id, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [{ id: 'term-unknown' }] },
        'workspace.list': { workspaces: [entry(alice, 'w-alice'), entry(bob, 'w-bob')], truncated: false }
      }
    })
    const worker = await mountWorker(main, { host })
    const context = (await worker.request('repo.getContext')) as any
    assert.ok(context.ambiguous)
    assert.equal(context.workspacePath, alice)
    await worker.deactivate()
  }
))

const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
type OrcaRunner = (cli: string, args: string[]) => Promise<{ stdout: string }>
const missingBinary = (): Error => Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' })
const noOrca: OrcaRunner = async () => {
  throw missingBinary()
}
main.testHooks.execOrca = noOrca

/** Answers only `orca terminal show --terminal=<id> --json`; any other argv fails the call loudly. */
function terminalShowStub(answers: Record<string, () => Promise<{ stdout: string }>>, calls: string[][]): OrcaRunner {
  return async (cli, args) => {
    calls.push([cli, ...args])
    const flag = args.length === 4 && args[0] === 'terminal' && args[1] === 'show' && args[3] === '--json'
      ? /^--terminal=(.+)$/.exec(args[2])
      : null
    if (!flag) throw new Error(`unexpected orca argv: ${args.join(' ')}`)
    const answer = answers[flag[1]]
    if (!answer) throw new Error(`unexpected terminal ${flag[1]}`)
    return answer()
  }
}
const showPath = (path: string) => async () => ({
  stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term-1', worktreeId: `repo::${path}`, worktreePath: path } } })
})
const showStale = async (): Promise<{ stdout: string }> => {
  throw Object.assign(new Error('Command failed: orca terminal show'), {
    code: 1,
    stdout: JSON.stringify({ ok: false, error: { code: 'terminal_handle_stale', message: 'stale' } })
  })
}
const showTimeout = async (): Promise<{ stdout: string }> => {
  throw Object.assign(new Error('Command failed: orca terminal show'), { killed: true, signal: 'SIGTERM', stdout: '' })
}

async function withOrca(runner: OrcaRunner, run: () => Promise<void>): Promise<void> {
  main.testHooks.execOrca = runner
  try {
    await run()
  } finally {
    main.testHooks.execOrca = noOrca
  }
}

const sameNameHost = (paths: string[], terminals: { id: string }[] = [{ id: 'term-1' }]) => {
  const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
  return mockHost({
    capabilities: ['storage:own', 'workspace:read', 'agent:read'],
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'main', terminals },
      'workspace.list': { workspaces: paths.map(entry), truncated: false }
    }
  })
}

test('a focused terminal resolved through the orca CLI join ends the ambiguity', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    await withOrca(terminalShowStub({ 'term-1': showPath(bob) }, calls), async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
      const context = (await worker.request('repo.getContext')) as any
      assert.ok(!context.ambiguous)
      assert.equal(context.workspacePath, bob)
      assert.deepEqual(calls, [[APP_ORCA, 'terminal', 'show', '--terminal=term-1', '--json']])
      await worker.deactivate()
    })
  }
))

test('a stale terminal handle is a cached miss that keeps the picker', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    await withOrca(terminalShowStub({ 'term-1': showStale }, calls), async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
      const first = (await worker.request('repo.getContext')) as any
      assert.ok(first.ambiguous)
      assert.equal(first.workspacePath, alice)
      const second = (await worker.request('repo.getContext')) as any
      assert.ok(second.ambiguous)
      assert.equal(calls.length, 1)
      await worker.deactivate()
    })
  }
))

test('a terminal with no local worktree is a cached miss', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    const remote = async () => ({ stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term-1', worktreePath: null } } }) })
    await withOrca(terminalShowStub({ 'term-1': remote }, calls), async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
      assert.ok(((await worker.request('repo.getContext')) as any).ambiguous)
      assert.ok(((await worker.request('repo.getContext')) as any).ambiguous)
      assert.equal(calls.length, 1)
      await worker.deactivate()
    })
  }
))

test('an ok:false answer other than a stale handle is retried, not cached', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    let answer = async (): Promise<{ stdout: string }> => {
      throw Object.assign(new Error('Command failed: orca terminal show'), {
        code: 1,
        stdout: JSON.stringify({ ok: false, error: { code: 'runtime_unavailable', message: 'Orca is starting' } })
      })
    }
    await withOrca(terminalShowStub({ 'term-1': () => answer() }, calls), async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
      assert.ok(((await worker.request('repo.getContext')) as any).ambiguous)
      answer = showPath(bob)
      const second = (await worker.request('repo.getContext')) as any
      assert.equal(second.workspacePath, bob)
      assert.equal(calls.length, 2)
      await worker.deactivate()
    })
  }
))

test('a timed-out CLI lookup is not cached and is retried on the next collect', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    let answer = showTimeout
    await withOrca(terminalShowStub({ 'term-1': () => answer() }, calls), async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
      const first = (await worker.request('repo.getContext')) as any
      assert.ok(first.ambiguous)
      assert.equal(calls.length, 1)
      answer = showPath(bob)
      const second = (await worker.request('repo.getContext')) as any
      assert.ok(!second.ambiguous)
      assert.equal(second.workspacePath, bob)
      assert.equal(calls.length, 2)
      await worker.deactivate()
    })
  }
))

test('output that is not JSON is not cached either', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    await withOrca(terminalShowStub({ 'term-1': async () => ({ stdout: 'Orca is starting...' }) }, calls), async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
      assert.ok(((await worker.request('repo.getContext')) as any).ambiguous)
      assert.ok(((await worker.request('repo.getContext')) as any).ambiguous)
      assert.equal(calls.length, 2)
      await worker.deactivate()
    })
  }
))

test('the bundled CLI is tried first and a bare orca on PATH only when it is missing', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    const show = terminalShowStub({ 'term-1': showPath(bob) }, calls)
    const runner: OrcaRunner = async (cli, args) => {
      if (cli === APP_ORCA) {
        calls.push([cli, ...args])
        throw missingBinary()
      }
      return show(cli, args)
    }
    await withOrca(runner, async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
      const context = (await worker.request('repo.getContext')) as any
      assert.equal(context.workspacePath, bob)
      assert.deepEqual(calls.map((c) => c[0]), [APP_ORCA, 'orca'])
      await worker.deactivate()
    })
  }
))

test('a CLI that runs but fails does not fall through to a bare orca on PATH', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    await withOrca(terminalShowStub({ 'term-1': showTimeout }, calls), async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
      await worker.request('repo.getContext')
      assert.deepEqual(calls.map((c) => c[0]), [APP_ORCA])
      await worker.deactivate()
    })
  }
))

test('a unique match never spawns the orca CLI', withTempWorkspaces(
  ['wb-alice'],
  async ([alice]) => {
    const calls: string[][] = []
    await withOrca(terminalShowStub({}, calls), async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice]) })
      const context = (await worker.request('repo.getContext')) as any
      assert.equal(context.workspacePath, alice)
      assert.deepEqual(calls, [])
      await worker.deactivate()
    })
  }
))

test('a terminal id shaped like a flag never reaches the orca CLI', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    await withOrca(terminalShowStub({}, calls), async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice, bob], [{ id: '--host=evil' }]) })
      const context = (await worker.request('repo.getContext')) as any
      assert.ok(context.ambiguous)
      assert.deepEqual(calls, [])
      await worker.deactivate()
    })
  }
))

test('a focused terminal whose CLI-joined path is outside the candidates stays ambiguous', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    await withOrca(terminalShowStub({ 'term-1': showPath('/somewhere/else') }, calls), async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
      const context = (await worker.request('repo.getContext')) as any
      assert.ok(context.ambiguous)
      assert.equal(context.workspacePath, alice)
      await worker.deactivate()
    })
  }
))

test('a locker hint among the candidates is shown preselected without writing a pick', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const host = sameNameHost([alice, bob])
    const worker = await mountWorker(main, { host })
    const context = (await worker.request('repo.getContext', { hintPath: bob })) as any
    assert.equal(context.workspacePath, bob)
    assert.equal(context.resolvedBy, 'hint')
    assert.ok(context.ambiguous)
    assert.deepEqual(context.candidates.map((c: any) => c.path), [alice, bob])
    assert.equal(host.data().storage.workspaceChoices, undefined)
    const plain = (await worker.request('repo.getContext')) as any
    assert.equal(plain.workspacePath, alice)
    assert.equal(plain.resolvedBy, null)
    await worker.deactivate()
  }
))

test('a locker hint beats the pick shared across same-name workspaces', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
    const picked = (await worker.request('repo.chooseWorkspace', { path: bob })) as any
    assert.equal(picked.workspacePath, bob)
    assert.equal(picked.resolvedBy, 'pick')
    const hinted = (await worker.request('repo.getContext', { hintPath: alice })) as any
    assert.equal(hinted.workspacePath, alice)
    assert.equal(hinted.resolvedBy, 'hint')
    await worker.deactivate()
  }
))

test('a locker hint outside the candidates is ignored', withTempWorkspaces(
  ['wb-alice', 'wb-bob', 'wb-carol'],
  async ([alice, bob, carol]) => {
    const worker = await mountWorker(main, { host: sameNameHost([alice, bob]) })
    const context = (await worker.request('repo.getContext', { hintPath: carol })) as any
    assert.equal(context.workspacePath, alice)
    assert.notEqual(context.resolvedBy, 'hint')
    await worker.deactivate()
  }
))

test('contexts say which signal resolved them', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const unique = await mountWorker(main, { host: sameNameHost([alice]) })
    assert.equal(((await unique.request('repo.getContext')) as any).resolvedBy, 'unique')
    await unique.deactivate()
    await withOrca(terminalShowStub({ 'term-1': showPath(bob) }, []), async () => {
      const joined = await mountWorker(main, { host: sameNameHost([alice, bob]) })
      const context = (await joined.request('repo.getContext')) as any
      assert.equal(context.resolvedBy, 'terminal')
      assert.equal(context.focusMoved, false)
      await joined.deactivate()
    })
  }
))

test('a context reports when the focus moved while it was being collected', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const entry = (path: string) => ({ id: path, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
    let terminals = [{ id: 'term-1' }]
    let moveDuringList = false
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': () => ({ branch: 'main', displayName: 'main', terminals }),
        'workspace.list': () => {
          if (moveDuringList) {
            moveDuringList = false
            terminals = [{ id: 'term-2' }]
          }
          return { workspaces: [entry(alice), entry(bob)], truncated: false }
        }
      }
    })
    await withOrca(terminalShowStub({ 'term-1': showPath(bob), 'term-2': showPath(alice) }, []), async () => {
      const worker = await mountWorker(main, { host })
      assert.equal(((await worker.request('repo.getContext')) as any).focusMoved, false)
      moveDuringList = true
      const moved = (await worker.request('repo.getContext')) as any
      assert.equal(moved.workspacePath, bob)
      assert.equal(moved.focusMoved, true)
      await worker.deactivate()
    })
  }
))

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
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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

test('no workspace matching the focused branch or name is reported rather than guessed', withTempWorkspaces(
  ['wb-one', 'wb-two'],
  async ([one, two]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
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
    assert.equal(result.workspacePath, null)
    assert.ok(!result.ambiguous)
    assert.equal(result.candidates, undefined)
    assert.equal(result.issuesError, 'No local workspace matches the focused workspace')
    await worker.deactivate()
  }
))

test('a single local workspace that does not match the focused one is not used', withTempWorkspaces(
  ['wb-only'],
  async ([only]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': { branch: 'feature-x', displayName: 'feature-x', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'main', path: only, branch: 'main', hostId: null },
            { id: 'w1', kind: 'worktree', name: 'feature-x', path: '/remote/x', branch: 'feature-x', hostId: 'ssh-box' }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, null)
    assert.ok(!result.ambiguous)
    assert.equal(result.branchesError, 'No local workspace matches the focused workspace')
    assert.deepEqual(result.branches, [])
    await worker.deactivate()
  }
))

test('with nothing focused no workspace is guessed', withTempWorkspaces(
  ['wb-only'],
  async ([only]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': null,
        'workspace.list': {
          workspaces: [{ id: 'w0', kind: 'worktree', name: 'main', path: only, branch: 'main', hostId: null }],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, null)
    assert.ok(!result.ambiguous)
    assert.deepEqual(result.branches, [])
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

test('focused on main in an SSH or hosted repo resolves to the matching local workspace by project', withTempWorkspaces(
  ['wb-my-project', 'wb-other-project'],
  async ([myProj, otherProj]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'my-project', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'main', project: 'my-project', path: myProj, branch: 'main', hostId: null },
            { id: 'w1', kind: 'worktree', name: 'main', project: 'other-project', path: otherProj, branch: 'main', hostId: null },
            { id: 'w2', kind: 'worktree', name: 'my-project', project: 'my-project', path: '/remote/ssh/path', branch: 'main', hostId: 'ssh-buildbox' }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, myProj)
    assert.ok(!result.ambiguous)
    assert.equal(result.resolvedBy, 'unique')
    assert.equal(result.candidates, undefined)
    await worker.deactivate()
  }
))

test('focused on an SSH repo with empty branch resolves to the matching local workspace by project', withTempWorkspaces(
  ['wb-my-project', 'wb-other-project'],
  async ([myProj, otherProj]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': { branch: '', displayName: 'my-project', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'main', project: 'my-project', path: myProj, branch: 'main', hostId: null },
            { id: 'w1', kind: 'worktree', name: 'main', project: 'other-project', path: otherProj, branch: 'main', hostId: null },
            { id: 'w2', kind: 'worktree', name: 'my-project', project: 'my-project', path: '/remote/ssh/path', branch: '', hostId: 'ssh-buildbox' }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, myProj)
    assert.ok(!result.ambiguous)
    assert.equal(result.resolvedBy, 'unique')
    assert.equal(result.candidates, undefined)
    await worker.deactivate()
  }
))

test('focused on an SSH repo with custom workspace name resolves via remote workspace project', withTempWorkspaces(
  ['wb-my-project', 'wb-other-project'],
  async ([myProj, otherProj]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'cloud-dev', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'main', project: 'my-project', path: myProj, branch: 'main', hostId: null },
            { id: 'w1', kind: 'worktree', name: 'main', project: 'other-project', path: otherProj, branch: 'main', hostId: null },
            { id: 'w2', kind: 'worktree', name: 'cloud-dev', project: 'my-project', path: '/remote/ssh/path', branch: 'main', hostId: 'ssh-buildbox' }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, myProj)
    assert.ok(!result.ambiguous)
    assert.equal(result.resolvedBy, 'unique')
    assert.equal(result.candidates, undefined)
    await worker.deactivate()
  }
))

test('resolveWorkspace resolves remote terminal owner project to matching local workspace', withTempWorkspaces(
  ['wb-my-project', 'wb-other-project'],
  async ([myProj, otherProj]) => {
    const terminalOwners = new Map([['t-remote', 'w2']])
    const resolution = main.resolveWorkspace(
      { branch: 'main', displayName: 'main', terminals: [{ id: 't-remote' }] },
      [
        { id: 'w0', kind: 'worktree', name: 'main', project: 'my-project', path: myProj, branch: 'main', hostId: null },
        { id: 'w1', kind: 'worktree', name: 'main', project: 'other-project', path: otherProj, branch: 'main', hostId: null },
        { id: 'w2', kind: 'worktree', name: 'cloud-dev', project: 'my-project', path: '/remote/ssh/path', branch: 'main', hostId: 'ssh-buildbox' }
      ],
      new Map(),
      terminalOwners
    )
    assert.equal(resolution.workspacePath, myProj)
    assert.ok(!resolution.ambiguous)
    assert.equal(resolution.resolvedBy, 'unique')
  }
))

test('extractProjectFromTitle parses project names from various shell and agent prompts', () => {
  assert.equal(extractProjectFromTitle('Review SPX NDX BTC ETH forecasts | tarottraderhistory'), 'tarottraderhistory')
  assert.equal(extractProjectFromTitle('nhang@ML-1: /mnt/c/Projects/DecoN'), 'DecoN')
  assert.equal(extractProjectFromTitle('user@remote: ~/code/my-repo $'), 'my-repo')
  assert.equal(extractProjectFromTitle('/Users/nhangen/code/my-repo %'), 'my-repo')
  assert.equal(extractProjectFromTitle('C:\\Projects\\my-repo>'), 'my-repo')
  assert.equal(extractProjectFromTitle('nhangen@MBP-2026 orca-plugins %'), 'orca-plugins')
  assert.equal(extractProjectFromTitle(''), null)
  assert.equal(extractProjectFromTitle(null), null)
  assert.equal(extractProjectFromTitle('..'), null)
  assert.equal(extractProjectFromTitle('Terminal 1'), null)
})

test('a terminal title only preselects a discovered clone and keeps the picker up', async () => {
  const parentDir = mkdtempSync(join(tmpdir(), 'sources-'))
  const localClone = join(parentDir, 'DecoN')
  const unrelated = join(parentDir, 'unrelated-app')
  mkdirSync(join(localClone, '.git'), { recursive: true })
  mkdirSync(join(unrelated, '.git'), { recursive: true })
  try {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': {
          branch: 'master',
          displayName: 'master',
          terminals: [{ id: 'term-remote', title: 'nhang@ML-1: /mnt/c/Projects/DecoN' }]
        },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'master', project: 'unrelated-app', path: unrelated, branch: 'master', hostId: null }
          ],
          truncated: false
        }
      }
    })
    main.testHooks.cloneRoots = [parentDir]
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, localClone)
    assert.ok(result.ambiguous)
    assert.notEqual(result.resolvedBy, 'terminal')
    assert.deepEqual(result.candidates.map((c: any) => c.path), [localClone, unrelated])
    await worker.deactivate()
  } finally {
    main.testHooks.cloneRoots = []
    rmSync(parentDir, { recursive: true, force: true })
  }
})

test('a terminal title naming no known repo does not rule out the workspace on the branch', withTempWorkspaces(
  ['wb-unrelated'],
  async ([unrelated]) => {
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read', 'agent:read'],
      results: {
        'workspace.readContext': {
          branch: 'master',
          displayName: 'master',
          terminals: [{ id: 'term-remote', title: 'nhang@ML-1: /mnt/c/Projects/non-existent-repo' }]
        },
        'workspace.list': {
          workspaces: [
            { id: 'w0', kind: 'worktree', name: 'master', project: 'unrelated', path: unrelated, branch: 'master', hostId: null }
          ],
          truncated: false
        }
      }
    })
    const worker = await mountWorker(main, { host })
    const result = (await worker.request('repo.getContext')) as any
    assert.equal(result.workspacePath, unrelated)
    assert.ok(!result.ambiguous)
    await worker.deactivate()
  }
))

test('queryTerminalPath falls back to paired environment when terminal is on remote server', withTempWorkspaces(
  ['wb-alice', 'wb-bob'],
  async ([alice, bob]) => {
    const calls: string[][] = []
    const pairedStale = async () => {
      throw Object.assign(new Error('Command failed: orca terminal show'), {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          error: {
            code: 'terminal_handle_stale',
            message: 'terminal_handle_stale',
            data: {
              nextSteps: [
                'Terminal handles belong to the Orca server that issued them. If this handle came from a paired server (for example orca terminal list --environment <server>), pass the same --environment <server> to this command.'
              ]
            }
          }
        })
      })
    }
    const envList = async () => ({
      stdout: JSON.stringify({ ok: true, result: { environments: [{ id: 'env-1', name: 'ml1-wsl' }] } })
    })
    const remoteShow = async () => ({
      stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term-remote', worktreePath: bob } } })
    })

    const runner: OrcaRunner = async (cli, args) => {
      calls.push([cli, ...args])
      if (args[0] === 'environment' && args[1] === 'list') return envList()
      if (args[0] === 'terminal' && args[1] === 'show') {
        if (args.includes('--environment=ml1-wsl')) return remoteShow()
        return pairedStale()
      }
      throw new Error(`unexpected orca argv: ${args.join(' ')}`)
    }

    await withOrca(runner, async () => {
      const host = mockHost({
        capabilities: ['storage:own', 'workspace:read', 'agent:read'],
        results: {
          'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [{ id: 'term-remote' }] },
          'workspace.list': {
            workspaces: [
              { id: 'w0', kind: 'worktree', name: 'main', path: alice, branch: 'main', hostId: null },
              { id: 'w1', kind: 'worktree', name: 'main', path: bob, branch: 'main', hostId: null }
            ],
            truncated: false
          }
        }
      })
      const worker = await mountWorker(main, { host })
      const result = (await worker.request('repo.getContext')) as any
      assert.equal(result.workspacePath, bob)
      assert.ok(!result.ambiguous)
      assert.equal(result.resolvedBy, 'terminal')
      await worker.deactivate()
    })
  }
))

test('focused terminal on remote worktree discovers unlisted local clone on default branch instead of ambiguous picker', async () => {
  const parentDir = mkdtempSync(join(tmpdir(), 'sources-'))
  const swarm = join(parentDir, 'swarm')
  const shieldWall = join(parentDir, 'shield-wall')
  const localClone = join(parentDir, 'my-remote-repo')
  mkdirSync(join(swarm, '.git'), { recursive: true })
  mkdirSync(join(shieldWall, '.git'), { recursive: true })
  mkdirSync(join(localClone, '.git'), { recursive: true })
  try {
    const runner: OrcaRunner = async (cli, args) => {
      if (args[0] === 'environment' && args[1] === 'list') {
        return { stdout: JSON.stringify({ ok: true, result: { environments: [{ id: 'env-1', name: 'ml1-wsl' }] } }) }
      }
      if (args[0] === 'terminal' && args[1] === 'show') {
        if (args.includes('--environment=ml1-wsl')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: { terminal: { handle: 'term-remote', worktreePath: '/mnt/c/Projects/my-remote-repo' } }
            })
          }
        }
        throw Object.assign(new Error('stale'), {
          code: 1,
          stdout: JSON.stringify({
            ok: false,
            error: {
              code: 'terminal_handle_stale',
              message: 'terminal_handle_stale',
              data: { nextSteps: ['pass the same --environment <server> to this command.'] }
            }
          })
        })
      }
      throw new Error(`unexpected orca argv: ${args.join(' ')}`)
    }

    await withOrca(runner, async () => {
      const host = mockHost({
        capabilities: ['storage:own', 'workspace:read', 'agent:read'],
        results: {
          'workspace.readContext': { branch: 'master', displayName: 'master', terminals: [{ id: 'term-remote' }] },
          'workspace.list': {
            workspaces: [
              { id: 'w0', kind: 'worktree', name: 'master', project: 'swarm', path: swarm, branch: 'master', hostId: null },
              { id: 'w1', kind: 'worktree', name: 'master', project: 'shield-wall', path: shieldWall, branch: 'master', hostId: null }
            ],
            truncated: false
          }
        }
      })
      const worker = await mountWorker(main, { host })
      const result = (await worker.request('repo.getContext')) as any
      assert.equal(result.workspacePath, localClone)
      assert.ok(!result.ambiguous)
      assert.equal(result.resolvedBy, 'discovered')
      await worker.deactivate()
    })
  } finally {
    rmSync(parentDir, { recursive: true, force: true })
  }
})

test('the one active remote worktree on the branch preselects its local clone in the picker', async () => {
  const parentDir = mkdtempSync(join(tmpdir(), 'sources-'))
  const swarm = join(parentDir, 'swarm')
  const shieldWall = join(parentDir, 'shield-wall')
  const localClone = join(parentDir, 'my-remote-repo')
  mkdirSync(join(swarm, '.git'), { recursive: true })
  mkdirSync(join(shieldWall, '.git'), { recursive: true })
  mkdirSync(join(localClone, '.git'), { recursive: true })
  try {
    const runner: OrcaRunner = async (cli, args) => {
      if (args[0] === 'environment' && args[1] === 'list') {
        return { stdout: JSON.stringify({ ok: true, result: { environments: [{ id: 'env-1', name: 'ml1-wsl' }] } }) }
      }
      if (args[0] === 'worktree' && args[1] === 'ps') {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  repo: 'my-remote-repo',
                  path: '/mnt/c/Projects/my-remote-repo',
                  branch: 'refs/heads/master',
                  hasHostSidebarActivity: true,
                  sidebarStatus: 'active'
                }
              ]
            }
          })
        }
      }
      throw new Error(`unexpected orca argv: ${args.join(' ')}`)
    }

    await withOrca(runner, async () => {
      const host = mockHost({
        capabilities: ['storage:own', 'workspace:read', 'agent:read'],
        results: {
          'workspace.readContext': { branch: 'master', displayName: 'master', terminals: [] },
          'workspace.list': {
            workspaces: [
              { id: 'w0', kind: 'worktree', name: 'master', project: 'swarm', path: swarm, branch: 'master', hostId: null },
              { id: 'w1', kind: 'worktree', name: 'master', project: 'shield-wall', path: shieldWall, branch: 'master', hostId: null }
            ],
            truncated: false
          }
        }
      })
      const worker = await mountWorker(main, { host })
      const result = (await worker.request('repo.getContext')) as any
      assert.equal(result.workspacePath, localClone)
      assert.ok(result.ambiguous)
      assert.equal(result.resolvedBy, null)
      assert.equal(result.candidates.length, 3)
      await worker.deactivate()
    })
  } finally {
    rmSync(parentDir, { recursive: true, force: true })
  }
})

const localEntry = (id: string, name: string, path: string, branch: string, project?: string) => ({
  id, kind: 'worktree', name, project, path, branch, hostId: null
})

test('a display name that matches no repo still resolves the one workspace on the branch', withTempWorkspaces(
  ['wb-feat'],
  async ([feat]) => {
    const resolution = main.resolveWorkspace(
      { branch: 'feat', displayName: 'My Feature', terminals: [] },
      [localEntry('w0', 'feat-wt', feat, 'feat')],
      new Map()
    )
    assert.equal(resolution.workspacePath, feat)
    assert.equal(resolution.resolvedBy, 'unique')
  }
))

test('a noisy terminal title on the default branch keeps the picker', withTempWorkspaces(
  ['wb-alpha', 'wb-beta'],
  async ([alpha, beta]) => {
    const resolution = main.resolveWorkspace(
      { branch: 'main', displayName: 'main', terminals: [{ id: 't1', title: 'npm run build | tee' }] },
      [localEntry('w0', 'main', alpha, 'main'), localEntry('w1', 'main', beta, 'main')],
      new Map()
    )
    assert.ok(resolution.ambiguous)
    assert.equal(resolution.candidates.length, 2)
  }
))

test('a remote workspace named after the branch does not pick a local repo', withTempWorkspaces(
  ['wb-swarm', 'wb-shield'],
  async ([swarm, shield]) => {
    const resolution = main.resolveWorkspace(
      { branch: 'main', displayName: 'main', terminals: [] },
      [
        localEntry('w0', 'main', swarm, 'main', 'swarm'),
        localEntry('w1', 'main', shield, 'main', 'shield'),
        { id: 'w2', kind: 'worktree', name: 'main', project: 'shield', path: '/remote/shield', branch: 'main', hostId: 'ssh-box' }
      ],
      new Map()
    )
    assert.ok(resolution.ambiguous)
    assert.equal(resolution.candidates.length, 2)
  }
))

test('an active remote worktree on another branch does not resolve the focus', async () => {
  const parentDir = mkdtempSync(join(tmpdir(), 'sources-'))
  const alpha = join(parentDir, 'alpha')
  const beta = join(parentDir, 'beta')
  for (const dir of [alpha, beta, join(parentDir, 'zz')]) mkdirSync(join(dir, '.git'), { recursive: true })
  try {
    const runner: OrcaRunner = async (_cli, args) => {
      if (args[0] === 'environment') return { stdout: JSON.stringify({ ok: true, result: { environments: [{ name: 'box' }] } }) }
      if (args[0] === 'worktree') {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { worktrees: [{ repo: 'zz', path: '/remote/zz', branch: 'other', isActive: true, defaultBranch: 'main' }] }
          })
        }
      }
      throw new Error(`unexpected orca argv: ${args.join(' ')}`)
    }
    await withOrca(runner, async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alpha, beta], []) })
      const result = (await worker.request('repo.getContext')) as any
      assert.ok(result.ambiguous)
      assert.deepEqual(result.candidates.map((c: any) => c.path), [alpha, beta])
      await worker.deactivate()
    })
  } finally {
    rmSync(parentDir, { recursive: true, force: true })
  }
})

test('a bundled CLI that times out is not retried as a bare orca on PATH', withTempWorkspaces(
  ['wb-alpha', 'wb-beta'],
  async ([alpha, beta]) => {
    const calls: string[] = []
    const runner: OrcaRunner = async (cli, args) => {
      calls.push(cli)
      if (cli === 'orca') return { stdout: JSON.stringify({ ok: true, result: { environments: [{ name: 'box' }] } }) }
      throw Object.assign(new Error(`timed out: ${args.join(' ')}`), { code: 'ETIMEDOUT', killed: true, stdout: '' })
    }
    await withOrca(runner, async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alpha, beta], []) })
      await worker.request('repo.getContext')
      assert.ok(calls.length > 0)
      assert.ok(!calls.includes('orca'))
      await worker.deactivate()
    })
  }
))

test('an empty worktree list from the bundled CLI is not retried as a bare orca on PATH', withTempWorkspaces(
  ['wb-alpha', 'wb-beta'],
  async ([alpha, beta]) => {
    const calls: string[] = []
    const runner: OrcaRunner = async (cli, args) => {
      calls.push(`${cli} ${args[0]}`)
      if (args[0] === 'environment') return { stdout: JSON.stringify({ ok: true, result: { environments: [{ name: 'box' }] } }) }
      if (args[0] === 'worktree') return { stdout: JSON.stringify({ ok: true, result: { worktrees: [] } }) }
      throw new Error(`unexpected orca argv: ${args.join(' ')}`)
    }
    await withOrca(runner, async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alpha, beta], []) })
      await worker.request('repo.getContext')
      assert.ok(calls.includes(`${APP_ORCA} worktree`))
      assert.ok(!calls.includes('orca worktree'))
      await worker.deactivate()
    })
  }
))

test('a paired terminal whose environment lookup times out is asked again on the next collect', withTempWorkspaces(
  ['wb-alpha', 'wb-beta'],
  async ([alpha, beta]) => {
    let plainShows = 0
    const runner: OrcaRunner = async (cli, args) => {
      if (cli === 'orca') throw missingBinary()
      if (args[0] === 'environment') return { stdout: JSON.stringify({ ok: true, result: { environments: [{ name: 'box' }] } }) }
      if (args[0] === 'terminal' && args.some((a) => a.startsWith('--environment='))) {
        throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', stdout: '' })
      }
      if (args[0] === 'terminal') {
        plainShows++
        throw Object.assign(new Error('stale'), {
          code: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { code: 'terminal_handle_stale', data: { nextSteps: ['pass the same --environment <server> to this command.'] } }
          })
        })
      }
      throw new Error(`unexpected orca argv: ${args.join(' ')}`)
    }
    await withOrca(runner, async () => {
      const worker = await mountWorker(main, { host: sameNameHost([alpha, beta]) })
      await worker.request('repo.getContext')
      await worker.request('repo.getContext')
      assert.equal(plainShows, 2)
      await worker.deactivate()
    })
  }
))

test('a project name that is not a single folder name never leaves the clone roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'roots-'))
  try {
    mkdirSync(join(root, 'a', 'ws'), { recursive: true })
    mkdirSync(join(root, 'x', '.git'), { recursive: true })
    const known = [localEntry('w0', 'ws', join(root, 'a', 'ws'), 'main')]
    assert.equal(main.findLocalCloneForProject(known as any, '../x'), null)
    assert.equal(main.findLocalCloneForProject(known as any, 'x'), join(root, 'x'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('project matching ignores case between the remote name and the local workspace', withTempWorkspaces(
  ['wb-decon', 'wb-other'],
  async ([decon, other]) => {
    const resolution = main.resolveWorkspace(
      { branch: 'main', displayName: 'DECON', terminals: [] },
      [localEntry('w0', 'main', decon, 'main', 'DecoN'), localEntry('w1', 'main', other, 'main', 'other')],
      new Map()
    )
    assert.equal(resolution.workspacePath, decon)
    assert.ok(!resolution.ambiguous)
  }
))
