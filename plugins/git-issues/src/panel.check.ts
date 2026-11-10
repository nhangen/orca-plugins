// `orca plugin check` renders the panel once per scenario.
import { defineCheck } from 'orca/testing'
import type { RepoContext } from './protocol'

const mockContext: RepoContext = {
  repoSlug: 'nhangen/llm-tools',
  currentBranch: 'main',
  workspacePath: '/Users/nhangen/code/llm-tools',
  fetchedAt: Date.now(),
  requestedAt: Date.now(),
  workerEpoch: 'check',
  issues: [
    {
      number: 101,
      title: 'Fix sidebar tab transition',
      state: 'OPEN',
      url: 'https://github.com/nhangen/llm-tools/issues/101',
      author: 'nhangen',
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now() - 3600000,
      labels: [{ name: 'bug' }]
    },
    {
      number: 100,
      title: 'Support custom worktree icons',
      state: 'CLOSED',
      url: 'https://github.com/nhangen/llm-tools/issues/100',
      author: 'nhangen',
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now() - 86400000,
      labels: [{ name: 'feature' }]
    }
  ],
  pullRequests: [
    {
      number: 12,
      title: 'Add pull request view to sidebar',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/nhangen/llm-tools/pull/12',
      author: 'nhangen',
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now() - 1800000,
      headRefName: 'feat/pr-tab',
      baseRefName: 'main',
      labels: [{ name: 'enhancement' }]
    }
  ],
  branches: [
    {
      name: 'main',
      isHead: true,
      upstream: 'origin/main',
      lastCommitSubject: 'Merge pull request #1156',
      lastCommitDate: '2026-11-08'
    },
    {
      name: 'orca/orca-plugin-git-issues',
      isHead: false,
      lastCommitSubject: 'Add git-issues plugin',
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
          { path: '/Users/nhangen/code/llm-tools', name: 'llm-tools' },
          { path: '/Users/nhangen/code/claude-ceo', name: 'claude-ceo' }
        ]
      })
    }
  }
})
