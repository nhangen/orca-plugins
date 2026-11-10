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
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
