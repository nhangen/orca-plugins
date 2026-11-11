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

const alphaBeta = [
  { path: '/code/alpha', name: 'alpha' },
  { path: '/code/beta', name: 'beta' }
]

/** A worker double that resolves an ambiguous focus like the real one: hint, then the stored pick. */
function lockerHost(options: { storedPick?: string } = {}) {
  const contextRequests: { hintPath?: string }[] = []
  const picks: string[] = []
  let stamp = 100
  let storedPick = options.storedPick ?? '/code/alpha'
  const ambiguousAt = (path: string, resolvedBy: RepoContext['resolvedBy']): RepoContext => ({
    ...sampleContext,
    repoSlug: `owner/${path.split('/').pop()}`,
    workspacePath: path,
    requestedAt: ++stamp,
    ambiguous: true,
    resolvedBy,
    candidates: alphaBeta
  })
  const host = mockHost({
    requests: {
      'repo.getContext': (input) => {
        contextRequests.push({ hintPath: input?.hintPath })
        const hint = alphaBeta.find((c) => c.path === input?.hintPath)
        return hint ? ambiguousAt(hint.path, 'hint') : ambiguousAt(storedPick, 'pick')
      },
      'repo.chooseWorkspace': (input) => {
        picks.push(input.path)
        storedPick = input.path
        return ambiguousAt(input.path, 'pick')
      }
    }
  })
  return { host, contextRequests, picks, ambiguousAt }
}

test('a manual pick survives a locker that pointed at another workspace', async () => {
  const { host, picks } = lockerHost()
  const view = await mount(panel, { host, persisted: { workspace: { lastResolvedPath: '/code/alpha' } } })
  await view.settled()
  await view.select(view.find({ role: 'combobox' })!, '/code/beta')
  await view.settled()
  await view.settled()
  assert.deepEqual(picks, ['/code/beta'])
  assert.ok(view.find({ text: 'owner/beta' }))
  assert.equal(view.persisted.workspace.lastResolvedPath, '/code/beta')
  await view.unmount()
})

test('the locker hint rides on repo.getContext and never writes a pick', async () => {
  const { host, contextRequests, picks, ambiguousAt } = lockerHost({ storedPick: '/code/beta' })
  const view = await mount(panel, { host, persisted: { workspace: { lastResolvedPath: '/code/alpha' } } })
  await view.settled()
  assert.equal(contextRequests[0]?.hintPath, '/code/alpha')
  assert.ok(view.find({ text: 'owner/alpha' }))
  await view.post('repo.changed', ambiguousAt('/code/beta', 'pick'))
  await view.settled()
  await view.settled()
  assert.ok(view.find({ text: 'owner/alpha' }))
  assert.deepEqual(contextRequests.map((r) => r.hintPath), ['/code/alpha', '/code/alpha'])
  assert.deepEqual(picks, [])
  assert.ok(view.find({ role: 'combobox' }))
  await view.unmount()
})

test('a hint the worker could not honor is not re-requested in a loop', async () => {
  const contextRequests: unknown[] = []
  let stamp = 100
  const host = mockHost({
    requests: {
      'repo.getContext': (input) => {
        contextRequests.push(input)
        return { ...sampleContext, workspacePath: '/code/beta', requestedAt: ++stamp, ambiguous: true, resolvedBy: 'pick', candidates: alphaBeta }
      }
    }
  })
  const view = await mount(panel, { host, persisted: { workspace: { lastResolvedPath: '/code/alpha' } } })
  await view.settled()
  await view.settled()
  assert.equal(contextRequests.length, 1)
  await view.unmount()
})

test('a terminal-resolved context the panel rejected as stale never writes the locker', async () => {
  const host = mockHost({
    requests: {
      'repo.getContext': () => ({ ...sampleContext, workspacePath: '/code/beta', requestedAt: 200, resolvedBy: 'terminal' })
    }
  })
  const view = await mount(panel, { host })
  await view.settled()
  assert.equal(view.persisted.workspace.lastResolvedPath, '/code/beta')
  await view.post('repo.changed', { ...sampleContext, workspacePath: '/code/alpha', requestedAt: 50, resolvedBy: 'terminal' })
  await view.settled()
  assert.equal(view.persisted.workspace.lastResolvedPath, '/code/beta')
  await view.unmount()
})

test('a context whose focus moved while it was collected never writes the locker', async () => {
  const host = mockHost({ requests: { 'repo.getContext': () => sampleContext } })
  const view = await mount(panel, { host })
  await view.settled()
  await view.post('repo.changed', { ...sampleContext, repoSlug: 'owner/alpha', workspacePath: '/code/alpha', requestedAt: sampleContext.requestedAt + 300, resolvedBy: 'terminal', focusMoved: true })
  await view.settled()
  assert.ok(view.find({ text: 'owner/alpha' }))
  assert.equal(view.persisted.workspace.lastResolvedPath ?? null, null)
  await view.unmount()
})

test('only a terminal-resolved context fills the locker', async () => {
  const host = mockHost({ requests: { 'repo.getContext': () => sampleContext } })
  const view = await mount(panel, { host })
  await view.settled()
  await view.post('repo.changed', { ...sampleContext, workspacePath: '/code/unique', requestedAt: sampleContext.requestedAt + 300, resolvedBy: 'unique' })
  await view.settled()
  assert.equal(view.persisted.workspace.lastResolvedPath ?? null, null)
  await view.post('repo.changed', { ...sampleContext, workspacePath: '/code/alpha', requestedAt: sampleContext.requestedAt + 400, resolvedBy: 'terminal' })
  await view.settled()
  assert.equal(view.persisted.workspace.lastResolvedPath, '/code/alpha')
  await view.unmount()
})
