// `orca plugin check` renders the panel once per scenario.
import { defineCheck } from 'orca/testing'
import type { RepoContext } from './protocol'

const mockContext: RepoContext = {
  repoSlug: 'nhangen/llm-tools',
  currentBranch: 'main',
  workspacePath: '/Users/nhangen/code/llm-tools',
  fetchedAt: Date.now(),
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
    storage: {
      latestContext: mockContext
    }
  }
})
