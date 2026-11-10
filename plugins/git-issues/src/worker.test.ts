import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { parseGitRemote, parseGitBranches } from './worker'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('worker picks the folder workspace when its branch is null and a sibling worktree is listed first', async () => {
  const folderPath = '/Users/nhangen/code/my-project'
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'my-project', terminals: [] },
      'workspace.list': {
        workspaces: [
          {
            id: 'w0',
            kind: 'worktree',
            name: 'draft',
            path: '/Users/nhangen/code/my-project.wt',
            branch: 'refs/heads/draft',
            hostId: null
          },
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
})

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

test('worker prefers a worktree whose branch matches the focused branch', async () => {
  const worktreePath = '/Users/nhangen/code/my-project.wt'
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    results: {
      'workspace.readContext': { branch: 'draft', displayName: 'draft', terminals: [] },
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'folder', name: 'my-project', path: '/Users/nhangen/code/my-project', branch: null, hostId: null },
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
})
