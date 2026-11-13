import { defineCheck } from 'orca/testing'
import type { RepoContext } from './protocol'

const mockContext: RepoContext = {
  repoSlug: 'example-org/project',
  currentBranch: 'feat/quick-search',
  workspacePath: '/workspace/project',
  fetchedAt: Date.now(),
  requestedAt: Date.now(),
  workerEpoch: 'check',
  issues: [
    {
      number: 101,
      title: 'Fix sidebar tab transition',
      state: 'OPEN',
      url: 'https://github.com/example-org/project/issues/101',
      author: 'contributor',
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now() - 3600000,
      labels: [{ name: 'bug' }]
    },
    {
      number: 100,
      title: 'Support custom worktree icons',
      state: 'CLOSED',
      url: 'https://github.com/example-org/project/issues/100',
      author: 'contributor',
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now() - 86400000,
      labels: [{ name: 'feature' }]
    },
    ...([
      [99, 'Keep filters when switching workspaces', 'enhancement'],
      [98, 'Add keyboard shortcuts for navigation', 'feature'],
      [97, 'Improve empty state descriptions', 'enhancement'],
      [96, 'Refresh branch tracking after a fetch', 'bug'],
      [95, 'Show review status beside pull requests', 'feature'],
      [94, 'Remember the selected repository', 'enhancement'],
      [93, 'Support light and dark color themes', 'feature'],
      [92, 'Keep issue titles readable in narrow panels', 'bug'],
      [91, 'Link tracked branches to their remote', 'feature'],
      [90, 'Improve loading feedback during refresh', 'enhancement']
    ] as const).map(([number, title, label], index) => ({
      number,
      title,
      state: 'OPEN' as const,
      url: `https://github.com/example-org/project/issues/${number}`,
      author: 'contributor',
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now() - (index + 2) * 3600000,
      labels: [{ name: label }]
    }))
  ],
  pullRequests: [
    {
      number: 12,
      title: 'Add quick search to the sidebar',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/example-org/project/pull/12',
      author: 'contributor',
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now() - 1800000,
      headRefName: 'feat/quick-search',
      baseRefName: 'main',
      labels: [{ name: 'enhancement' }]
    }
  ],
  branches: [
    {
      name: 'main',
      isHead: false,
      upstream: 'origin/main',
      lastCommitSubject: 'Refresh project documentation',
      lastCommitDate: '2026-11-08'
    },
    {
      name: 'feat/quick-search',
      isHead: true,
      upstream: 'origin/feat/quick-search',
      lastCommitSubject: 'Add quick search',
      lastCommitDate: '2026-11-10'
    }
  ]
}

export default defineCheck({
  fresh: {},
  loaded: {
    requests: {
      'repo.getContext': () => mockContext
    }
  },
  ambiguous: {
    requests: {
      'repo.getContext': () => ({
        ...mockContext,
        ambiguous: true,
        candidates: [
          { path: '/workspace/project', name: 'project' },
          { path: '/workspace/docs', name: 'docs' }
        ]
      })
    }
  }
})
