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
  /** When collection started; orders contexts, since a slower, earlier collect can finish last. */
  requestedAt: number
  /** Identifies the worker run; requestedAt is only comparable within one epoch. */
  workerEpoch: string
  /** True when several workspaces share the focused branch+name and Orca does not expose which is focused. */
  ambiguous?: boolean
  /** The indistinguishable workspaces the panel can pick between when `ambiguous`. */
  candidates?: RepoCandidate[]
  /**
   * Which signal chose `workspacePath`: the only match, a focused terminal, the panel's
   * per-workspace hint, the pick shared by every workspace on this branch+name, or none of them.
   */
  resolvedBy?: ResolvedBy
  /** True when Orca's focus changed while this context was collected, so it may describe another workspace. */
  focusMoved?: boolean
}

export type ResolvedBy = 'unique' | 'terminal' | 'discovered' | 'hint' | 'pick' | null

declare module 'orca' {
  interface PluginRequests {
    /** Gets the current repository context (issues, branches, current branch, and repo slug). */
    'repo.getContext': {
      input: { forceRefresh?: boolean; hintPath?: string }
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
