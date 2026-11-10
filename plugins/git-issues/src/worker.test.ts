import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { parseGitRemote, parseGitBranches } from './worker'

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
  await worker.deactivate()
})

test('worker reports ambiguous candidates when several workspaces share the focused branch', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
      'workspace.list': {
        workspaces: [
          { id: 'a', kind: 'worktree', name: 'main', path: '/code/alice', branch: 'main', hostId: null },
          { id: 'b', kind: 'worktree', name: 'main', path: '/code/bob', branch: 'main', hostId: null }
        ],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  const context = (await worker.request('repo.getContext')) as any
  assert.ok(context.ambiguous)
  assert.equal(context.candidates.length, 2)
  assert.equal(context.workspacePath, '/code/alice')
  const chosen = (await worker.request('repo.chooseWorkspace', { path: '/code/bob' })) as any
  assert.ok(chosen.ambiguous)
  assert.deepEqual(host.data().storage.workspaceChoices, { 'main|main': '/code/bob' })
  const after = (await worker.request('repo.getContext')) as any
  assert.equal(after.workspacePath, '/code/bob')
  await worker.deactivate()
})

test('worker honors a stored workspace pick on a fresh worker', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    storage: { workspaceChoices: { 'main|main': '/code/bob' } },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
      'workspace.list': {
        workspaces: [
          { id: 'a', kind: 'worktree', name: 'main', path: '/code/alice', branch: 'main', hostId: null },
          { id: 'b', kind: 'worktree', name: 'main', path: '/code/bob', branch: 'main', hostId: null }
        ],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  const context = (await worker.request('repo.getContext')) as any
  assert.equal(context.workspacePath, '/code/bob')
  await worker.deactivate()
})

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
