import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { RepoContext } from './protocol'

const sampleContext: RepoContext = {
  repoSlug: 'test-owner/test-repo',
  currentBranch: 'feature/orca-sidebar',
  workspacePath: '/mock/path/test-repo',
  fetchedAt: 1700000000000,
  requestedAt: 1700000000000,
  workerEpoch: 'epoch-a',
  issues: [
    {
      number: 42,
      title: 'Implement sidebar tab for issues',
      state: 'OPEN',
      url: 'https://github.com/test-owner/test-repo/issues/42',
      author: 'alice',
      updatedAt: '2026-11-10T00:00:00Z',
      updatedAtMs: 1700000000000,
      labels: [{ name: 'enhancement' }]
    },
    {
      number: 41,
      title: 'Fix branch ordering',
      state: 'CLOSED',
      url: 'https://github.com/test-owner/test-repo/issues/41',
      author: 'bob',
      updatedAt: '2026-11-09T00:00:00Z',
      updatedAtMs: 1699900000000,
      labels: []
    }
  ],
  pullRequests: [
    {
      number: 10,
      title: 'Add PR support to sidebar',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/test-owner/test-repo/pull/10',
      author: 'carol',
      updatedAt: '2026-11-10T00:00:00Z',
      updatedAtMs: 1700000000000,
      headRefName: 'feat/prs',
      baseRefName: 'main',
      labels: []
    },
    {
      number: 9,
      title: 'Draft PR for testing',
      state: 'OPEN',
      isDraft: true,
      url: 'https://github.com/test-owner/test-repo/pull/9',
      author: 'dave',
      updatedAt: '2026-11-09T00:00:00Z',
      updatedAtMs: 1699900000000,
      headRefName: 'draft/test',
      baseRefName: 'main',
      labels: []
    }
  ],
  branches: [
    {
      name: 'feature/orca-sidebar',
      isHead: true,
      upstream: 'origin/feature/orca-sidebar',
      lastCommitSubject: 'Add panel components',
      lastCommitDate: '2026-11-10'
    },
    {
      name: 'main',
      isHead: false,
      upstream: 'origin/main',
      lastCommitSubject: 'Initial commit',
      lastCommitDate: '2026-11-08'
    }
  ]
}

test('renders repo context and switches tabs', async () => {
  const host = mockHost({
    requests: {
      'repo.getContext': () => sampleContext
    }
  })

  const view = await mount(panel, { host })
  await view.settled()

  // Check header displays repo
  assert.ok(view.find({ text: 'test-owner/test-repo' }))

  // Default filter is "open" -> Issue #42 should be visible as a ListItem with its title text
  assert.ok(view.find({ text: '#42 Implement sidebar tab for issues' }))

  // Switch to "closed" filter
  await view.press({ text: 'Closed (1)' })
  await view.settled()
  assert.ok(view.find({ text: '#41 Fix branch ordering' }))

  // Switch tab to PRs
  await view.select({ role: 'tablist' }, 'prs')
  await view.settled()
  assert.ok(view.find({ text: '#10 Add PR support to sidebar' }))

  // Switch PR filter to draft
  await view.press({ text: 'Draft (1)' })
  await view.settled()
  assert.ok(view.find({ text: '#9 Draft PR for testing' }))

  // Switch tab to Branches
  await view.select({ role: 'tablist' }, 'branches')
  await view.settled()
  assert.ok(view.find({ text: 'feature/orca-sidebar' }))
  assert.ok(view.find({ text: 'main' }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('applies pushed context even when the first request failed', async () => {
  const host = mockHost({
    requests: {
      'repo.getContext': () => {
        throw hostError('timeout', 'worker busy')
      }
    }
  })
  const view = await mount(panel, { host })
  await view.settled()
  await view.post('repo.changed', sampleContext)
  await view.settled()
  assert.ok(view.find({ text: 'test-owner/test-repo' }))
  await view.unmount()
})

test('ignores a pushed context requested before the one shown', async () => {
  const host = mockHost({ requests: { 'repo.getContext': () => sampleContext } })
  const view = await mount(panel, { host })
  await view.settled()
  const older: RepoContext = { ...sampleContext, repoSlug: 'stale/repo', requestedAt: sampleContext.requestedAt - 1000, fetchedAt: sampleContext.fetchedAt + 5000 }
  await view.post('repo.changed', older)
  await view.settled()
  assert.ok(view.find({ text: 'test-owner/test-repo' }))
  assert.equal(view.find({ text: 'stale/repo' }), null)
  await view.unmount()
})

test('shows the workspace picker while ambiguous and applies a pick', async () => {
  const ambiguousContext: RepoContext = {
    ...sampleContext,
    workspacePath: '/code/alpha',
    ambiguous: true,
    candidates: [
      { path: '/code/alpha', name: 'alpha' },
      { path: '/code/beta', name: 'beta' }
    ]
  }
  const picks: string[] = []
  const host = mockHost({
    requests: {
      'repo.getContext': () => ambiguousContext,
      'repo.chooseWorkspace': (input) => {
        picks.push(input.path)
        return { ...ambiguousContext, workspacePath: input.path, repoSlug: 'owner/beta', requestedAt: ambiguousContext.requestedAt + 1 }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.settled()
  const picker = view.find({ role: 'combobox' })
  assert.ok(picker)
  await view.select(picker!, '/code/beta')
  await view.settled()
  assert.deepEqual(picks, ['/code/beta'])
  assert.ok(view.find({ text: 'owner/beta' }))
  await view.unmount()
})

test('accepts an older stamp from a restarted worker', async () => {
  const host = mockHost({ requests: { 'repo.getContext': () => sampleContext } })
  const view = await mount(panel, { host })
  await view.settled()
  const restarted: RepoContext = { ...sampleContext, repoSlug: 'owner/restarted', workerEpoch: 'epoch-b', requestedAt: sampleContext.requestedAt - 60000 }
  await view.post('repo.changed', restarted)
  await view.settled()
  assert.ok(view.find({ text: 'owner/restarted' }))
  await view.unmount()
})
