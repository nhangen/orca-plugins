// The plugin's own worker running in Node.js on the Orca host.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'
import type { JsonValue } from 'orca/host'
import type { GitBranch, GitIssue, GitPullRequest, RepoCandidate, RepoContext } from './protocol'

const exec = promisify(execFile)
const STORAGE_KEY = 'latestContext'
// Orca reports the focused workspace as {branch, displayName} only, and names every root clone after
// its branch, so separate repos on their default branch are indistinguishable; the user's pick for
// such a context is stored per branch+name key.
const CHOICES_KEY = 'workspaceChoices'

export interface WorkerState {
  /** Picks made this session; they win over storage so a pick holds even when the write failed. */
  sessionChoices: Map<string, string>
  latestPostedRequestedAt: number
  lastRequestedAt: number
  /** requestedAt only orders contexts from one worker; a restarted worker starts a new epoch. */
  epoch: string
  /** Serializes CHOICES_KEY read-modify-writes so a prune cannot overwrite a concurrent pick. */
  choicesQueue: Promise<void>
}

export function createWorkerState(): WorkerState {
  return {
    sessionChoices: new Map(),
    latestPostedRequestedAt: 0,
    lastRequestedAt: 0,
    epoch: randomUUID(),
    choicesQueue: Promise.resolve()
  }
}

function parseStoredChoices(stored: JsonValue | null): Map<string, string> {
  const map = new Map<string, string>()
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, path] of Object.entries(stored)) {
      if (typeof path === 'string') map.set(key, path)
    }
  }
  return map
}

async function readChoices(orca: OrcaWorkerApi, state: WorkerState): Promise<Map<string, string>> {
  let stored = new Map<string, string>()
  try {
    stored = parseStoredChoices(await orca.storage.get(CHOICES_KEY))
  } catch (err: any) {
    console.error('git-issues: could not read workspace picks:', err?.message || String(err))
  }
  return new Map([...stored, ...state.sessionChoices])
}

function updateStoredChoices(
  orca: OrcaWorkerApi,
  state: WorkerState,
  mutate: (choices: Map<string, string>) => boolean
): Promise<void> {
  const run = state.choicesQueue.then(async () => {
    const choices = parseStoredChoices(await orca.storage.get(CHOICES_KEY))
    if (testHooks.afterChoicesRead) await testHooks.afterChoicesRead()
    if (mutate(choices)) await orca.storage.set(CHOICES_KEY, Object.fromEntries(choices))
  })
  state.choicesQueue = run.catch(() => {})
  return run
}

async function pruneChoices(orca: OrcaWorkerApi, state: WorkerState): Promise<void> {
  for (const [key, path] of state.sessionChoices) {
    if (!existsSync(path)) state.sessionChoices.delete(key)
  }
  try {
    await updateStoredChoices(orca, state, (choices) => {
      let changed = false
      for (const [key, path] of choices) {
        if (!existsSync(path)) {
          choices.delete(key)
          changed = true
        }
      }
      return changed
    })
  } catch (err: any) {
    console.error('git-issues: could not prune workspace picks:', err?.message || String(err))
  }
}

const EXEC_ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`
}

export function parseGitRemote(url: string): string | null {
  const trimmed = url.trim()
  const match = trimmed.match(/[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/)
  if (!match) return null
  const [, owner, repo] = match
  if ([owner, repo].some((segment) => segment === '.' || segment === '..')) return null
  return `${owner}/${repo}`
}

export function parseGitBranches(stdout: string): { branches: GitBranch[]; currentBranch: string | null } {
  const lines = stdout.trim().split('\n').filter(Boolean)
  const branches: GitBranch[] = []
  let currentBranch: string | null = null

  for (const line of lines) {
    const parts = line.split('|')
    const name = parts[0]?.trim()
    if (!name) continue
    const isHead = parts[1]?.trim() === '*'
    const upstream = parts[2]?.trim() || undefined
    const lastCommitSubject = parts[3]?.trim() || undefined
    const lastCommitDate = parts[4]?.trim() || undefined

    if (isHead) {
      currentBranch = name
    }

    branches.push({
      name,
      isHead,
      upstream,
      lastCommitSubject,
      lastCommitDate
    })
  }

  return { branches, currentBranch }
}

export async function fetchGitHubIssues(repoSlug: string, cwd: string): Promise<{ issues: GitIssue[]; error?: string }> {
  // Option A: Try GitHub CLI first (uses local existing user session)
  try {
    const { stdout } = await exec(
      'gh',
      ['issue', 'list', '--repo', repoSlug, '--state', 'all', '--limit', '50', '--json', 'number,title,state,url,author,updatedAt,labels'],
      { cwd, env: EXEC_ENV, timeout: 10000 }
    )
    const raw = JSON.parse(stdout)
    if (Array.isArray(raw)) {
      const issues: GitIssue[] = raw.map((item: any) => ({
        number: Number(item.number),
        title: String(item.title ?? ''),
        state: String(item.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
        url: String(item.url ?? `https://github.com/${repoSlug}/issues/${item.number}`),
        author: item.author?.login || item.author?.name || undefined,
        updatedAt: String(item.updatedAt ?? ''),
        updatedAtMs: item.updatedAt ? new Date(item.updatedAt).getTime() : undefined,
        labels: Array.isArray(item.labels)
          ? item.labels.map((l: any) => ({ name: String(l.name), color: l.color ? String(l.color) : undefined }))
          : [],
        commentsCount: typeof item.commentsCount === 'number' ? item.commentsCount : undefined
      }))
      return { issues }
    }
  } catch (ghErr: any) {
    console.error('GH CLI ERROR:', ghErr?.message || String(ghErr), ghErr?.stderr)
    // If gh CLI fails, fall through to public API
  }

  // Option B: Public GitHub REST API fallback
  try {
    const response = await fetch(`https://api.github.com/repos/${repoSlug}/issues?state=all&per_page=50`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Orca-Git-Issues-Plugin'
      }
    })

    if (!response.ok) {
      return {
        issues: [],
        error: `GitHub API error: HTTP ${response.status} ${response.statusText}`
      }
    }

    const raw = await response.json()
    if (Array.isArray(raw)) {
      // Exclude pull requests (GitHub API returns PRs in issues endpoint if pull_request key exists)
      const issues: GitIssue[] = raw
        .filter((item: any) => !item.pull_request)
        .map((item: any) => ({
          number: Number(item.number),
          title: String(item.title ?? ''),
          state: String(item.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
          url: String(item.html_url ?? `https://github.com/${repoSlug}/issues/${item.number}`),
          author: item.user?.login || undefined,
          updatedAt: String(item.updated_at ?? ''),
          updatedAtMs: item.updated_at ? new Date(item.updated_at).getTime() : undefined,
          labels: Array.isArray(item.labels)
            ? item.labels.map((l: any) => ({ name: String(l.name), color: l.color ? String(l.color) : undefined }))
            : [],
          commentsCount: typeof item.comments === 'number' ? item.comments : undefined
        }))
      return { issues }
    }
  } catch (apiErr: any) {
    return {
      issues: [],
      error: `Failed to fetch issues: ${apiErr?.message || String(apiErr)}`
    }
  }

  return { issues: [] }
}

export async function fetchPullRequests(
  repoSlug: string,
  cwd: string
): Promise<{ pullRequests: GitPullRequest[]; error?: string }> {
  // Option A: Try GitHub CLI first (uses local existing user session)
  try {
    const { stdout } = await exec(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repoSlug,
        '--state',
        'all',
        '--limit',
        '50',
        '--json',
        'number,title,state,isDraft,url,author,updatedAt,headRefName,baseRefName,labels,mergedAt'
      ],
      { cwd, env: EXEC_ENV, timeout: 10000 }
    )
    const raw = JSON.parse(stdout)
    if (Array.isArray(raw)) {
      const pullRequests: GitPullRequest[] = raw.map((item: any) => ({
        number: Number(item.number),
        title: String(item.title ?? ''),
        state: String(item.state).toUpperCase() === 'MERGED' ? 'MERGED' : String(item.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
        isDraft: Boolean(item.isDraft),
        url: String(item.url ?? `https://github.com/${repoSlug}/pull/${item.number}`),
        author: item.author?.login || item.author?.name || undefined,
        updatedAt: String(item.updatedAt ?? ''),
        updatedAtMs: item.updatedAt ? new Date(item.updatedAt).getTime() : undefined,
        mergedAt: item.mergedAt ? String(item.mergedAt) : undefined,
        headRefName: item.headRefName ? String(item.headRefName) : undefined,
        baseRefName: item.baseRefName ? String(item.baseRefName) : undefined,
        labels: Array.isArray(item.labels)
          ? item.labels.map((l: any) => ({ name: String(l.name), color: l.color ? String(l.color) : undefined }))
          : []
      }))
      return { pullRequests }
    }
  } catch (ghErr: any) {
    console.error('GH PR CLI ERROR:', ghErr?.message || String(ghErr), ghErr?.stderr)
  }

  // Option B: Public GitHub REST API fallback
  try {
    const response = await fetch(`https://api.github.com/repos/${repoSlug}/pulls?state=all&per_page=50`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Orca-Git-Issues-Plugin'
      }
    })

    if (!response.ok) {
      return {
        pullRequests: [],
        error: `GitHub API error: HTTP ${response.status} ${response.statusText}`
      }
    }

    const raw = await response.json()
    if (Array.isArray(raw)) {
      const pullRequests: GitPullRequest[] = raw.map((item: any) => ({
        number: Number(item.number),
        title: String(item.title ?? ''),
        state: item.merged_at ? 'MERGED' : String(item.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
        isDraft: Boolean(item.draft),
        url: String(item.html_url ?? `https://github.com/${repoSlug}/pull/${item.number}`),
        author: item.user?.login || undefined,
        updatedAt: String(item.updated_at ?? ''),
        updatedAtMs: item.updated_at ? new Date(item.updated_at).getTime() : undefined,
        mergedAt: item.merged_at ? String(item.merged_at) : undefined,
        headRefName: item.head?.ref ? String(item.head.ref) : undefined,
        baseRefName: item.base?.ref ? String(item.base.ref) : undefined,
        labels: Array.isArray(item.labels)
          ? item.labels.map((l: any) => ({ name: String(l.name), color: l.color ? String(l.color) : undefined }))
          : []
      }))
      return { pullRequests }
    }
  } catch (apiErr: any) {
    return {
      pullRequests: [],
      error: `Failed to fetch PRs: ${apiErr?.message || String(apiErr)}`
    }
  }

  return { pullRequests: [] }
}

export interface WorkspaceEntry {
  id?: string
  kind?: 'worktree' | 'folder'
  name?: string
  path: string
  branch?: string | null
  hostId?: string | null
}

export interface FocusedContext {
  branch?: string | null
  displayName?: string | null
}

export interface WorkspaceResolution {
  workspacePath: string | null
  activeBranch: string | null
  key: string
  ambiguous: boolean
  candidates: RepoCandidate[]
}

export function stripRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

function choiceKey(branch: string | null, displayName: string | null): string {
  return `${branch ?? '-'}|${displayName ?? '-'}`
}

/** Orca reports this machine as hostId null (unresolved) or 'local'; every other id is a remote host. */
function isLocalWorkspace(w: WorkspaceEntry): boolean {
  return (w.hostId == null || w.hostId === 'local') && existsSync(w.path)
}

/** The shortest trailing run of folders that tells each path apart from the others. */
function candidateLabels(paths: string[]): string[] {
  const segments = paths.map((p) => p.split('/').filter(Boolean))
  return segments.map((s, i) => {
    for (let depth = 1; depth <= s.length; depth++) {
      const label = s.slice(-depth).join('/')
      const clash = segments.some((other, j) => j !== i && other.slice(-depth).join('/') === label)
      if (!clash) return label
    }
    return paths[i]
  })
}

export function resolveWorkspace(
  context: FocusedContext | null,
  workspaces: WorkspaceEntry[],
  choices: Map<string, string>
): WorkspaceResolution {
  const activeBranch = context?.branch ? stripRef(context.branch) : null
  const displayName = context?.displayName ?? null
  const key = choiceKey(activeBranch, displayName)
  const pool = workspaces.filter((w) => Boolean(w.path) && isLocalWorkspace(w))
  if (pool.length === 0) {
    return { workspacePath: null, activeBranch, key, ambiguous: false, candidates: [] }
  }

  const onBranch = activeBranch != null ? pool.filter((w) => w.branch != null && stripRef(w.branch) === activeBranch) : []
  const named = displayName != null ? pool.filter((w) => w.name === displayName) : []
  const both = onBranch.filter((w) => named.includes(w))
  // A folder workspace has no branch, so its name is the only signal that can match it.
  const namedFolders = named.filter((w) => w.branch == null)
  const matches = [both, namedFolders, onBranch, named].find((list) => list.length > 0) ?? []
  if (matches.length === 0) {
    return { workspacePath: null, activeBranch, key, ambiguous: false, candidates: [] }
  }

  if (matches.length === 1) {
    return { workspacePath: matches[0].path, activeBranch, key, ambiguous: false, candidates: [] }
  }

  const fallback = matches[0]
  const preferred = choices.get(key)
  const labels = candidateLabels(matches.map((w) => w.path))
  return {
    workspacePath: matches.find((w) => w.path === preferred)?.path ?? fallback.path,
    activeBranch,
    key,
    ambiguous: true,
    candidates: matches.map((w, i) => ({ path: w.path, name: labels[i] }))
  }
}

export async function collectRepoContext(orca: OrcaWorkerApi, state: WorkerState = createWorkerState()): Promise<RepoContext> {
  const requestedAt = Math.max(Date.now(), state.lastRequestedAt + 1)
  state.lastRequestedAt = requestedAt
  let workspacePath: string | null = null
  let activeBranch: string | null = null
  let contextCandidates: RepoCandidate[] | undefined
  let ambiguous = false
  let resolveError: string | null = null

  try {
    const context = await orca.host.call('workspace.readContext')
    if (context?.branch) activeBranch = stripRef(context.branch)
    const list = await orca.host.call('workspace.list')
    const workspaces = (list?.workspaces ?? []) as WorkspaceEntry[]
    let resolution = resolveWorkspace(context, workspaces, state.sessionChoices)
    if (resolution.ambiguous) {
      await pruneChoices(orca, state)
      resolution = resolveWorkspace(context, workspaces, await readChoices(orca, state))
      contextCandidates = resolution.candidates
    }
    workspacePath = resolution.workspacePath
    ambiguous = resolution.ambiguous
  } catch (err: any) {
    resolveError = `Could not read Orca workspaces: ${err?.message || String(err)}`
    console.error('git-issues: could not resolve the focused workspace:', err?.message || String(err))
  }

  let branches: GitBranch[] = []
  let branchesError: string | null = null
  let detectedHead: string | null = null
  let repoSlug: string | null = null
  let issues: GitIssue[] = []
  let pullRequests: GitPullRequest[] = []
  let issuesError: string | null = null
  let prsError: string | null = null

  if (!workspacePath) {
    const noWorkspace = resolveError ?? 'No local workspace matches the focused workspace'
    branchesError = noWorkspace
    issuesError = noWorkspace
    prsError = noWorkspace
  } else {
    const cwd = workspacePath
    try {
      const { stdout } = await exec(
        'git',
        ['branch', '--list', '--format=%(refname:short)|%(HEAD)|%(upstream:short)|%(subject)|%(committerdate:iso)'],
        { cwd, env: EXEC_ENV }
      )
      const parsed = parseGitBranches(stdout)
      branches = parsed.branches
      detectedHead = parsed.currentBranch
    } catch (err: any) {
      branchesError = `Git branch error: ${err?.message || String(err)}`
    }

    try {
      const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd, env: EXEC_ENV })
      repoSlug = parseGitRemote(stdout)
    } catch {
      // No git remote origin
    }

    if (repoSlug) {
      const [issuesResult, prsResult] = await Promise.all([
        fetchGitHubIssues(repoSlug, cwd),
        fetchPullRequests(repoSlug, cwd)
      ])
      issues = issuesResult.issues
      if (issuesResult.error) issuesError = issuesResult.error
      pullRequests = prsResult.pullRequests
      if (prsResult.error) prsError = prsResult.error
    } else {
      issuesError = 'No GitHub remote origin found for this workspace'
      prsError = 'No GitHub remote origin found for this workspace'
    }
  }

  const currentBranch = detectedHead ?? activeBranch

  const result: RepoContext = {
    repoSlug,
    currentBranch,
    workspacePath,
    issues,
    pullRequests,
    branches,
    issuesError,
    prsError,
    branchesError,
    fetchedAt: Date.now(),
    requestedAt,
    workerEpoch: state.epoch,
    ambiguous,
    candidates: contextCandidates
  }

  return result
}

/** Inert in production; tests hold a collect at the publish window to stage an interleaving. */
export const testHooks: {
  beforePublish: ((context: RepoContext) => Promise<void>) | null
  afterChoicesRead: (() => Promise<void>) | null
} = { beforePublish: null, afterChoicesRead: null }

async function publish(orca: OrcaWorkerApi, state: WorkerState, context: RepoContext): Promise<RepoContext> {
  if (testHooks.beforePublish) await testHooks.beforePublish(context)
  const serialized = JSON.stringify(context)
  const sanitized: RepoContext = JSON.parse(serialized)
  if (context.requestedAt < state.latestPostedRequestedAt) return sanitized
  state.latestPostedRequestedAt = context.requestedAt
  try {
    await orca.storage.set(STORAGE_KEY, JSON.parse(serialized))
  } catch {
    // storage cache save is non-blocking
  }
  orca.panels.post('repo.changed', sanitized)
  return sanitized
}

export default function activate(orca: OrcaWorkerApi): void {
  const state = createWorkerState()

  orca.panels.handle('repo.getContext', async () => {
    const context = await collectRepoContext(orca, state)
    return publish(orca, state, context)
  })

  orca.panels.handle('repo.chooseWorkspace', async (input: { path?: string }) => {
    const path = typeof input?.path === 'string' ? input.path : null
    if (path) {
      try {
        const context = await orca.host.call('workspace.readContext')
        const list = await orca.host.call('workspace.list')
        const resolution = resolveWorkspace(context, (list?.workspaces ?? []) as WorkspaceEntry[], state.sessionChoices)
        if (resolution.ambiguous && resolution.candidates.some((c) => c.path === path)) {
          state.sessionChoices.set(resolution.key, path)
          await updateStoredChoices(orca, state, (choices) => {
            choices.set(resolution.key, path)
            return true
          })
        }
      } catch (err: any) {
        console.error('git-issues: could not persist workspace pick:', err?.message || String(err))
      }
    }
    const fresh = await collectRepoContext(orca, state)
    return publish(orca, state, fresh)
  })

  // Whenever focused workspace or terminals change in Orca, refresh
  orca.events.on('workspace.changed', async () => {
    try {
      const context = await collectRepoContext(orca, state)
      await publish(orca, state, context)
    } catch {
      // ignore background refresh errors
    }
  })
}
