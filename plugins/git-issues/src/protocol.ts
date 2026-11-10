// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

export interface GitIssue {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  url: string
  author?: string
  updatedAt: string
  updatedAtMs?: number
  labels: { name: string; color?: string }[]
  commentsCount?: number
}

export interface GitBranch {
  name: string
  isHead: boolean
  upstream?: string
  lastCommitSubject?: string
  lastCommitDate?: string
}

export interface RepoContext {
  repoSlug: string | null
  currentBranch: string | null
  workspacePath: string | null
  issues: GitIssue[]
  branches: GitBranch[]
  issuesError?: string | null
  branchesError?: string | null
  fetchedAt: number
}

declare module 'orca' {
  interface PluginRequests {
    /** Gets the current repository context (issues, branches, current branch, and repo slug). */
    'repo.getContext': {
      input?: { forceRefresh?: boolean }
      output: RepoContext
    }
  }

  interface PluginPanelEvents {
    /** Posted to open panels when repository context changes or refreshes. */
    'repo.changed': RepoContext
  }
}
