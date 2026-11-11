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

  assert.ok(view.find({ text: 'test-owner/test-repo' }))

  assert.ok(view.find({ text: 'Implement sidebar tab for issues' }))
  assert.ok(view.find({ text: /^#42 · \S+$/ }))
  assert.equal(view.find({ text: /ago/ }), null)
  assert.equal(view.find({ text: 'Fix branch ordering' }), null)
  assert.equal(view.find({ text: /Opened by/ }), null)

  await view.select({ label: 'Issue state' }, 'closed')
  await view.settled()
  assert.ok(view.find({ text: 'Fix branch ordering' }))
  assert.equal(view.find({ text: 'Implement sidebar tab for issues' }), null)

  await view.select({ role: 'tablist' }, 'prs')
  await view.settled()
  assert.ok(view.find({ text: 'Add PR support to sidebar' }))
  assert.ok(view.find({ text: 'feat/prs → main' }))

  await view.select({ label: 'Pull request state' }, 'draft')
  await view.settled()
  assert.ok(view.find({ text: 'Draft PR for testing' }))
  assert.equal(view.find({ text: 'Add PR support to sidebar' }), null)

  await view.select({ role: 'tablist' }, 'branches')
  await view.settled()
  assert.ok(view.find({ text: 'main' }))
  assert.ok(view.find({ text: 'Initial commit' }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('the current-branch card opens the pull request for this branch', async () => {
  const branchPr = {
    ...sampleContext.pullRequests[1]!,
    number: 11,
    title: 'Wire panel components',
    headRefName: 'feature/orca-sidebar',
    url: 'https://github.com/test-owner/test-repo/pull/11'
  }
  const host = mockHost({
    requests: { 'repo.getContext': () => ({ ...sampleContext, pullRequests: [...sampleContext.pullRequests, branchPr] }) }
  })
  const view = await mount(panel, { host })
  await view.settled()
  const card = view.find({ type: 'ListItem', text: /Wire panel components/ })
  assert.ok(card)
  assert.match(card!.text, /#11/)
  assert.match(card!.text, /[Dd]raft/)
  assert.equal(card!.props.onPress, undefined)
  await view.press({ type: 'Link', text: 'Wire panel components' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: 'https://github.com/test-owner/test-repo/pull/11' }])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('a branch with no pull request offers to open one on GitHub', async () => {
  const host = mockHost({ requests: { 'repo.getContext': () => sampleContext } })
  const view = await mount(panel, { host })
  await view.settled()
  await view.press({ type: 'Link', text: 'Open a pull request' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [
    { url: 'https://github.com/test-owner/test-repo/compare/feature/orca-sidebar?expand=1' }
  ])
  await view.unmount()
})

test('a branch with no upstream is marked local only', async () => {
  const localOnly: RepoContext = {
    ...sampleContext,
    branches: sampleContext.branches.map(({ upstream, ...b }) => (b.isHead ? b : { ...b, upstream }))
  }
  const host = mockHost({ requests: { 'repo.getContext': () => localOnly } })
  const view = await mount(panel, { host })
  await view.settled()
  assert.ok(view.find({ type: 'ListItem', text: /feature\/orca-sidebar.*not pushed/i }))
  await view.select({ role: 'tablist' }, 'branches')
  await view.settled()
  assert.ok(view.find({ text: 'local only' }))
  await view.unmount()
})

test('a filter with no matches offers to clear it', async () => {
  const host = mockHost({ requests: { 'repo.getContext': () => sampleContext } })
  const view = await mount(panel, { host })
  await view.settled()
  await view.type({ label: 'Search issues' }, 'zzz-no-match')
  await view.settled()
  assert.equal(view.find({ text: 'Implement sidebar tab for issues' }), null)
  await view.press({ text: 'Clear filter' })
  await view.settled()
  assert.ok(view.find({ text: 'Implement sidebar tab for issues' }))
  await view.unmount()
})

test('a GitHub error offers a retry that forces a refresh', async () => {
  const inputs: unknown[] = []
  const host = mockHost({
    requests: {
      'repo.getContext': (input) => {
        inputs.push(input)
        return { ...sampleContext, issues: [], issuesError: 'gh is not authenticated' }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.settled()
  assert.ok(view.find({ text: /gh is not authenticated/ }))
  await view.press({ text: 'Retry' })
  await view.settled()
  assert.deepEqual(inputs.at(-1), { forceRefresh: true })
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
  const picker = view.find({ label: 'Workspace' })
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
  await view.select(view.find({ label: 'Workspace' })!, '/code/beta')
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
  assert.ok(view.find({ label: 'Workspace' }))
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

const issueWith = (title: string, labels: string[] = []) => ({ title, labels: labels.map((name) => ({ name })) })

test('issue icons follow labels first, then an exact title prefix, else neutral', () => {
  const cases: [string, string[], string][] = [
    ['Crash on launch', ['bug'], 'bug'],
    ['Crash on launch', ['Type: Bug'], 'bug'],
    ['Crash on launch', ['kind/bug'], 'bug'],
    ['Something', ['idea'], 'lightbulb'],
    ['Something', ['enhancement'], 'rocket'],
    ['Something', ['feature'], 'rocket'],
    ['Something', ['chore'], 'hammer'],
    ['Something', ['task'], 'hammer'],
    ['Something', ['question'], 'puzzle'],
    ['Something', ['discussion'], 'puzzle'],
    ['Something', ['documentation'], 'layers'],
    ['Something', ['security'], 'error'],
    ['Something', ['urgent'], 'error'],
    ['Something', ['bug', 'security'], 'error'],
    ['Something', ['idea', 'bug'], 'bug'],
    ['Idea: register the ML-1 5080', [], 'lightbulb'],
    ['Discuss: is llm-tools the right home', [], 'puzzle'],
    ['feat(panel): add icons', [], 'rocket'],
    ['Bug: tabs flicker', [], 'bug'],
    ['docs: update README', [], 'layers'],
    ['Fix the bug label color', [], 'plug'],
    ['Ideas for later', [], 'plug'],
    ['Pin ml3-3080 accelerator string', [], 'plug'],
    ['Idea: tidy', ['bug'], 'bug'],
    ['Something', ['wontfix'], 'plug']
  ]
  for (const [title, labels, icon] of cases) {
    assert.equal(panel.issueIcon(issueWith(title, labels)), icon, `${title} [${labels.join(', ')}]`)
  }
})

test('issue rows draw the type icon, closed issues included', async () => {
  const typed: RepoContext = {
    ...sampleContext,
    issues: [
      { ...sampleContext.issues[0]!, title: 'Idea: a lightbulb row', labels: [] },
      { ...sampleContext.issues[1]!, title: 'Closed crash', labels: [{ name: 'bug' }] }
    ]
  }
  const host = mockHost({ requests: { 'repo.getContext': () => typed } })
  const view = await mount(panel, { host })
  await view.settled()
  const rowIcon = (title: string) =>
    view.findAll({ type: 'IconButton', label: `Open on GitHub: ${title}` })[0]?.props.icon ??
    view.findAll({ type: 'ListItem' }).find((e) => e.text.includes(title))?.props.icon
  assert.equal(rowIcon('Idea: a lightbulb row'), 'lightbulb')
  await view.select({ label: 'Issue state' }, 'closed')
  await view.settled()
  assert.equal(rowIcon('Closed crash'), 'bug')
  await view.unmount()
})

test('only the title links to GitHub; rows themselves are not buttons', async () => {
  const withBranches: RepoContext = {
    ...sampleContext,
    branches: [
      ...sampleContext.branches,
      { name: 'scratch/local', isHead: false, lastCommitSubject: 'wip', lastCommitDate: '2026-11-07' },
      { name: 'fork-work', isHead: false, upstream: 'upstream/fork-work', lastCommitSubject: 'fork', lastCommitDate: '2026-11-06' }
    ]
  }
  const host = mockHost({ requests: { 'repo.getContext': () => withBranches } })
  const view = await mount(panel, { host })
  await view.settled()
  const link = (text: string) => view.findAll({ type: 'Link', text }).at(-1)
  const noPressableRows = () => assert.deepEqual(view.findAll({ type: 'ListItem' }).filter((e) => e.props.onPress), [])

  noPressableRows()
  await view.press(link('Implement sidebar tab for issues')!)
  await view.select({ role: 'tablist' }, 'prs')
  await view.settled()
  noPressableRows()
  await view.press(link('Add PR support to sidebar')!)
  await view.select({ role: 'tablist' }, 'branches')
  await view.settled()
  noPressableRows()
  await view.press(link('feature/orca-sidebar')!)
  assert.equal(link('scratch/local'), undefined)
  assert.equal(link('fork-work'), undefined)
  assert.ok(view.find({ text: 'scratch/local' }))

  assert.deepEqual(host.callsOf('shell.openExternal'), [
    { url: 'https://github.com/test-owner/test-repo/issues/42' },
    { url: 'https://github.com/test-owner/test-repo/pull/10' },
    { url: 'https://github.com/test-owner/test-repo/tree/feature/orca-sidebar' }
  ])
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test("each row's icon opens the same page as its title", async () => {
  const withLocal: RepoContext = {
    ...sampleContext,
    branches: [...sampleContext.branches, { name: 'scratch/local', isHead: false, lastCommitSubject: 'wip', lastCommitDate: '2026-11-07' }]
  }
  const host = mockHost({ requests: { 'repo.getContext': () => withLocal } })
  const view = await mount(panel, { host })
  await view.settled()
  const icon = (label: string) => view.find({ type: 'IconButton', label })

  await view.press(icon('Open on GitHub: Implement sidebar tab for issues'))
  await view.select({ role: 'tablist' }, 'prs')
  await view.settled()
  await view.press(icon('Open on GitHub: Add PR support to sidebar'))
  await view.select({ role: 'tablist' }, 'branches')
  await view.settled()
  await view.press(icon('Open on GitHub: feature/orca-sidebar'))
  assert.equal(view.findAll({ type: 'IconButton', label: 'Open on GitHub: scratch/local' }).length, 0)
  assert.equal(view.find({ type: 'ListItem', text: /scratch\/local/ }).props.icon, 'branch')

  assert.deepEqual(host.callsOf('shell.openExternal'), [
    { url: 'https://github.com/test-owner/test-repo/issues/42' },
    { url: 'https://github.com/test-owner/test-repo/pull/10' },
    { url: 'https://github.com/test-owner/test-repo/tree/feature/orca-sidebar' }
  ])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})
