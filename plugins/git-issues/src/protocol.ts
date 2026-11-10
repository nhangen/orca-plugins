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

export interface GitPullRequest {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  url: string
  author?: string
  updatedAt: string
  updatedAtMs?: number
  mergedAt?: string
  headRefName?: string
  baseRefName?: string
  labels: { name: string; color?: string }[]
}

export interface GitBranch {
  name: string
  isHead: boolean
  upstream?: string
  lastCommitSubject?: string
  lastCommitDate?: string
}

export interface RepoCandidate {
  path: string
  name: string
}

export interface RepoContext {
  repoSlug: string | null
  currentBranch: string | null
  workspacePath: string | null
  issues: GitIssue[]
  pullRequests: GitPullRequest[]
  branches: GitBranch[]
  issuesError?: string | null
  prsError?: string | null
  branchesError?: string | null
  fetchedAt: number
  /** True when several workspaces share the focused branch+name and Orca does not expose which is focused. */
  ambiguous?: boolean
  /** The indistinguishable workspaces the panel can pick between when `ambiguous`. */
  candidates?: RepoCandidate[]
}

  declare module 'orca' {
  interface PluginRequests {
    /** Gets the current repository context (issues, branches, current branch, and repo slug). */
    'repo.getContext': {
      input?: { forceRefresh?: boolean }
      output: RepoContext
    }
    /** Sets the user's workspace pick for an ambiguous focused context and returns a fresh context. */
    'repo.chooseWorkspace': {
      input: { path: string }
      output: RepoContext
    }
  }

  interface PluginPanelEvents {
    /** Posted to open panels when repository context changes or refreshes. */
    'repo.changed': RepoContext
  }
}
