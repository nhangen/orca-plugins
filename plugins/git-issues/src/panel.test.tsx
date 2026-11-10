import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { RepoContext } from './protocol'

const sampleContext: RepoContext = {
  repoSlug: 'test-owner/test-repo',
  currentBranch: 'feature/orca-sidebar',
  workspacePath: '/mock/path/test-repo',
  fetchedAt: 1700000000000,
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

  // Default filter is "open" -> Issue #42 should be visible as a ListItem with its title in label
  assert.ok(view.find({ label: '#42 Implement sidebar tab for issues' }))

  // Switch to "closed" filter
  await view.press({ text: 'Closed (1)' })
  await view.settled()
  assert.ok(view.find({ label: '#41 Fix branch ordering' }))

  // Switch tab to Branches
  await view.select({ role: 'tablist' }, 'branches')
  await view.settled()
  assert.ok(view.find({ label: 'feature/orca-sidebar' }))
  assert.ok(view.find({ label: 'main' }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
