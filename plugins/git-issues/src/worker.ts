// The plugin's own worker running in Node.js on the Orca host.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'
import type { JsonValue } from 'orca/host'
import type { GitBranch, GitIssue, GitPullRequest, RepoCandidate, RepoContext, ResolvedBy } from './protocol'

const exec = promisify(execFile)
const STORAGE_KEY = 'latestContext'
// Orca reports the focused workspace as {branch, displayName, terminalIds} only, and names every
// root clone after its branch, so separate repos on their default branch are indistinguishable by
// branch+name. In order, the ways out: a focused terminal joined to its worktree through the orca
// CLI; a terminal an agent.status.changed event tied to a workspace; the panel's per-workspace
// hint; and last, the user's pick, stored per branch+name key and so shared by every workspace
// that key matches.
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
  /** terminalId → workspaceId, learned from agent.status.changed events; one hit identifies the focused workspace. */
  terminalOwners: Map<string, string>
  /** terminalId → workspace path resolved through the Orca CLI; terminal ids are stable per incarnation. */
  focusedPathCache: Map<string, string | null>
  /** One CLI spawn per handle at a time; concurrent collects share it. */
  focusedPathLookups: Map<string, Promise<string | null>>
  /** Cached remote environment names from `orca environment list` to query paired terminals or worktrees. */
  environmentsCache?: string[]
}

export function createWorkerState(): WorkerState {
  return {
    sessionChoices: new Map(),
    latestPostedRequestedAt: 0,
    lastRequestedAt: 0,
    epoch: randomUUID(),
    choicesQueue: Promise.resolve(),
    terminalOwners: new Map(),
    focusedPathCache: new Map(),
    focusedPathLookups: new Map()
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

// The app's own CLI first: a bare `orca` on PATH can be an unrelated program (the GNOME screen
// reader, Plotly's image exporter), so it is only tried when the bundled binary does not exist.
const ORCA_CLI_CANDIDATES = ['/Applications/Orca.app/Contents/Resources/bin/orca', 'orca']
const TERMINAL_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/
const CACHE_LIMIT = 100

function rememberBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value as string)
  map.set(key, value)
}

/**
 * A path; null for a definitive answer without one (a stale handle, or a terminal with no local
 * worktree); undefined for anything that may change on retry, such as a runtime that is not ready.
 */
function parseTerminalShow(stdout: string): string | null | undefined {
  let parsed: { ok?: unknown; error?: { code?: unknown }; result?: { terminal?: { worktreePath?: unknown } } }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') return undefined
  if (!parsed.ok) return parsed.error?.code === 'terminal_handle_stale' ? null : undefined
  const path = parsed.result?.terminal?.worktreePath
  return typeof path === 'string' && path.length > 0 ? path : null
}

function runOrca(cli: string, args: string[]): Promise<{ stdout: string }> {
  if (testHooks.execOrca) return testHooks.execOrca(cli, args)
  return exec(cli, args, { env: EXEC_ENV, timeout: 5000, maxBuffer: 512 * 1024 })
}

/**
 * Maps a focused terminal handle to its workspace path via `orca terminal show`. Not part of the
 * plugin contract (the JSON shape could change), so every failure degrades to null and the
 * resolution falls back to agent-event correlation, the stored pick, or the picker. Only parsed
 * answers are cached: a timeout or a CLI that is still starting is retried on the next collect.
 * The command also returns a terminal preview; it is parsed in memory and never logged or kept.
 */
function lookupFocusedPath(state: WorkerState, terminalId: string): Promise<string | null> {
  if (!TERMINAL_HANDLE.test(terminalId)) return Promise.resolve(null)
  const cached = state.focusedPathCache.get(terminalId)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = state.focusedPathLookups.get(terminalId)
  if (pending) return pending
  const lookup = queryTerminalPath(state, terminalId).finally(() => state.focusedPathLookups.delete(terminalId))
  state.focusedPathLookups.set(terminalId, lookup)
  return lookup
}

async function getEnvironments(state: WorkerState): Promise<string[]> {
  if (state.environmentsCache) return state.environmentsCache
  for (const cli of ORCA_CLI_CANDIDATES) {
    try {
      const { stdout } = await runOrca(cli, ['environment', 'list', '--json'])
      const parsed = JSON.parse(stdout)
      if (parsed?.ok && Array.isArray(parsed?.result?.environments)) {
        const envs = parsed.result.environments
          .map((e: any) => (typeof e?.name === 'string' ? e.name : typeof e?.id === 'string' ? e.id : null))
          .filter(Boolean) as string[]
        state.environmentsCache = envs
        return envs
      }
    } catch {
      // CLI failed or not available
    }
  }
  return []
}

async function queryTerminalPath(state: WorkerState, terminalId: string): Promise<string | null> {
  for (const cli of ORCA_CLI_CANDIDATES) {
    let stdout: string | null = null
    try {
      ;({ stdout } = await runOrca(cli, ['terminal', 'show', `--terminal=${terminalId}`, '--json']))
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue
      // A stale handle exits 1 with its JSON answer on stdout.
      if (typeof err?.stdout === 'string' && err.stdout.length > 0) {
        stdout = err.stdout
      }
    }

    let path = stdout ? parseTerminalShow(stdout) : undefined
    let isPaired = false
    if (stdout) {
      try {
        const p = JSON.parse(stdout)
        if (
          p?.ok === false &&
          p?.error?.code === 'terminal_handle_stale' &&
          Array.isArray(p?.error?.data?.nextSteps) &&
          p.error.data.nextSteps.some((s: unknown) => typeof s === 'string' && s.includes('--environment'))
        ) {
          isPaired = true
        }
      } catch {}
    }

    if (isPaired) {
      const envs = await getEnvironments(state)
      for (const env of envs) {
        try {
          const { stdout: envStdout } = await runOrca(cli, [
            'terminal',
            'show',
            `--environment=${env}`,
            `--terminal=${terminalId}`,
            '--json'
          ])
          const envPath = parseTerminalShow(envStdout)
          if (typeof envPath === 'string' && envPath.length > 0) {
            path = envPath
            break
          }
        } catch {
          // not found in this environment
        }
      }
    }

    if (path === undefined) return null
    rememberBounded(state.focusedPathCache, terminalId, path)
    return path
  }
  return null
}

async function lookupActiveRemoteWorktree(
  state: WorkerState,
  workspaces: WorkspaceEntry[],
  activeBranch: string | null
): Promise<string | null> {
  const envs = await getEnvironments(state)
  for (const env of envs) {
    for (const cli of ORCA_CLI_CANDIDATES) {
      try {
        const { stdout } = await runOrca(cli, ['worktree', 'ps', `--environment=${env}`, '--json'])
        const parsed = JSON.parse(stdout)
        if (parsed?.ok && Array.isArray(parsed?.result?.worktrees)) {
          const active = parsed.result.worktrees.filter(
            (wt: any) => Boolean(wt?.hasHostSidebarActivity || wt?.sidebarStatus === 'active' || wt?.status === 'active' || wt?.isActive)
          )
          for (const wt of active) {
            const branch = typeof wt?.branch === 'string' ? stripRef(wt.branch) : null
            if (activeBranch == null || branch === activeBranch || wt?.defaultBranch) {
              const name = typeof wt?.repo === 'string' ? wt.repo : wt?.path ? wt.path.split(/[/\\]+/).filter(Boolean).pop() : null
              if (name) {
                const localClone = findLocalCloneForProject(workspaces, name)
                if (localClone) return localClone
                if (typeof wt?.path === 'string' && wt.path.length > 0) return wt.path
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }
  return null
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
  project?: string | null
  path: string
  branch?: string | null
  hostId?: string | null
}

export interface FocusedTerminal {
  id?: string
  title?: string | null
}

export interface FocusedContext {
  branch?: string | null
  displayName?: string | null
  terminals?: FocusedTerminal[] | null
}

export interface WorkspaceResolution {
  workspacePath: string | null
  activeBranch: string | null
  key: string
  ambiguous: boolean
  resolvedBy: ResolvedBy
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

/**
 * Extracts a candidate repository or project name from a terminal title or shell prompt.
 * Handles agent task titles ("Review ... | tarottraderhistory"),
 * SSH/remote prompts ("nhang@ML-1: /mnt/c/Projects/DecoN", "user@host: ~/code/my-repo $"),
 * path prompts ("/Users/nhangen/code/repo %"), and user@host directory prompts.
 */
export function extractProjectFromTitle(title: string | null | undefined): string | null {
  if (!title || typeof title !== 'string') return null
  const trimmed = title.trim()
  if (!trimmed) return null

  // 1. Agent title pattern with pipe: "Task Title | projectName"
  const pipeMatch = trimmed.match(/\|\s*([a-zA-Z0-9_.-]+)\s*$/)
  if (pipeMatch && pipeMatch[1] && pipeMatch[1] !== '.' && pipeMatch[1] !== '..') {
    return pipeMatch[1]
  }

  // 2. Prompt with colon followed by path: "nhang@ML-1: /mnt/c/Projects/DecoN" or "user@host:~/code/repo $"
  const colonPathMatch = trimmed.match(/:\s*([/~\\].*?)(?:\s*[$#%>]|\s*$)/)
  if (colonPathMatch && colonPathMatch[1]) {
    const rawPath = colonPathMatch[1].trim()
    const segments = rawPath.split(/[/\\]+/).filter(Boolean)
    const last = segments[segments.length - 1]
    if (last && last !== '.' && last !== '..') {
      return last
    }
  }

  // 3. Prompt starting with a path: "/Users/.../repo %" or "C:\Projects\repo>"
  const pathPromptMatch = trimmed.match(/^([/~\\].*?)(?:\s*[$#%>]|\s*$)/)
  if (pathPromptMatch && pathPromptMatch[1]) {
    const rawPath = pathPromptMatch[1].trim()
    const segments = rawPath.split(/[/\\]+/).filter(Boolean)
    const last = segments[segments.length - 1]
    if (last && last !== '.' && last !== '..') {
      return last
    }
  }

  // 4. Shell prompt with username@host and directory: "nhangen@MBP-2026 orca-plugins %"
  const userHostMatch = trimmed.match(/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+[:\s]+([a-zA-Z0-9_.-]+)(?:\s*[$#%>]|\s*$)/)
  if (userHostMatch && userHostMatch[1] && userHostMatch[1] !== '.' && userHostMatch[1] !== '..') {
    return userHostMatch[1]
  }

  return null
}

/**
 * Searches candidate root directories for a local clone matching the given project name.
 * Examines parents and grandparents of known workspace paths, plus common source locations (~/code, ~/Projects, etc.).
 */
export function findLocalCloneForProject(
  knownWorkspaces: WorkspaceEntry[],
  projectName: string
): string | null {
  if (!projectName || projectName === 'main' || projectName === 'master') return null
  const candidates: string[] = []

  // 1. Sibling directories of known local workspaces
  for (const w of knownWorkspaces) {
    if (w.path && isLocalWorkspace(w)) {
      const parent = dirname(w.path)
      candidates.push(join(parent, projectName))
      const grandParent = dirname(parent)
      candidates.push(join(grandParent, projectName))
    }
  }

  // 2. Common source roots under user home directory
  const home = homedir()
  const standardRoots = ['code', 'Projects', 'src', 'dev', 'workspace', 'workspaces', 'ML-AI']
  for (const root of standardRoots) {
    candidates.push(join(home, root, projectName))
  }

  // Check each unique candidate
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    try {
      if (existsSync(candidate) && existsSync(join(candidate, '.git'))) {
        return candidate
      }
    } catch {
      // ignore filesystem access errors
    }
  }

  return null
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
  choices: Map<string, string>,
  terminalOwners: Map<string, string> = new Map(),
  focusedPath: string | null = null,
  hintPath: string | null = null
): WorkspaceResolution {
  const activeBranch = context?.branch ? stripRef(context.branch) : null
  const displayName = context?.displayName ?? null
  const key = choiceKey(activeBranch, displayName)
  const pool = workspaces.filter((w) => Boolean(w.path) && isLocalWorkspace(w))

  const matchingProjects = new Set<string>()
  if (displayName != null) {
    matchingProjects.add(displayName)
    if (displayName !== activeBranch) {
      for (const w of workspaces) {
        if (!isLocalWorkspace(w) && w.name === displayName && w.project) {
          matchingProjects.add(w.project)
        }
      }
    }
  }

  for (const terminal of context?.terminals ?? []) {
    if (terminal?.title) {
      const proj = extractProjectFromTitle(terminal.title)
      if (proj) matchingProjects.add(proj)
    }
  }

  for (const w of workspaces) {
    if (!isLocalWorkspace(w) && w.project && (w.name === displayName || matchingProjects.has(w.name ?? ''))) {
      matchingProjects.add(w.project)
    }
  }

  const focused = focusedWorkspace(context, workspaces, terminalOwners)
  if (focused && !isLocalWorkspace(focused) && focused.project) {
    matchingProjects.add(focused.project)
  }

  if (focusedPath) {
    const proj = focusedPath.split(/[/\\]+/).filter(Boolean).pop()
    if (proj && proj.toLowerCase() !== 'main' && proj.toLowerCase() !== 'master' && proj.toLowerCase() !== activeBranch?.toLowerCase()) {
      const hasLocalClone =
        (existsSync(focusedPath) && existsSync(join(focusedPath, '.git'))) ||
        findLocalCloneForProject(workspaces, proj) !== null
      if (hasLocalClone) {
        matchingProjects.add(proj)
      }
    }
  }

  const specificProjects = new Set(
    Array.from(matchingProjects)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && p.toLowerCase() !== 'main' && p.toLowerCase() !== 'master' && p.toLowerCase() !== activeBranch?.toLowerCase())
  )

  const isDefaultBranchName = displayName === activeBranch || displayName === 'main' || displayName === 'master'

  let byProject = specificProjects.size > 0
    ? pool.filter((w) => {
        const proj = (w.project ?? '').toLowerCase()
        const name = (w.name ?? '').toLowerCase()
        const base = (w.path.split(/[/\\]+/).filter(Boolean).pop() ?? '').toLowerCase()
        for (const sp of specificProjects) {
          const s = sp.toLowerCase()
          if (proj === s || name === s || base === s) return true
        }
        return false
      })
    : []

  if (byProject.length === 0 && specificProjects.size > 0) {
    for (const proj of specificProjects) {
      const clonePath = findLocalCloneForProject(workspaces, proj)
      if (clonePath) {
        const synthetic: WorkspaceEntry = {
          id: `discovered:${clonePath}`,
          kind: 'worktree',
          name: proj,
          project: proj,
          path: clonePath,
          branch: activeBranch,
          hostId: 'local'
        }
        pool.push(synthetic)
        byProject.push(synthetic)
        break
      }
    }
  }

  if (pool.length === 0) {
    return { workspacePath: null, activeBranch, key, ambiguous: false, resolvedBy: null, candidates: [] }
  }

  const onBranch = activeBranch != null ? pool.filter((w) => w.branch != null && stripRef(w.branch) === activeBranch) : []
  const named = displayName != null ? pool.filter((w) => w.name === displayName) : []
  const bothNamed = onBranch.filter((w) => named.includes(w))
  const bothProject = onBranch.filter((w) => byProject.includes(w))

  // When displayName is just the branch name, bothNamed is merely matching default branch clones.
  // In that case, an identified project must take precedence.
  const both = isDefaultBranchName
    ? bothProject
    : bothNamed.length === 1
      ? bothNamed
      : bothProject.length > 0
        ? bothProject
        : bothNamed

  // A folder workspace has no branch, so its name is the only signal that can match it.
  const namedFolders = named.filter((w) => w.branch == null)

  // If a specific project was identified but not found locally, never fall back to unrelated workspaces on the branch
  const fallbackOnBranch = specificProjects.size > 0 && byProject.length === 0 ? [] : onBranch
  const fallbackNamed = specificProjects.size > 0 && isDefaultBranchName ? [] : named

  const matches = [both, namedFolders, byProject, fallbackOnBranch, fallbackNamed].find((list) => list.length > 0) ?? []
  if (matches.length === 0) {
    return { workspacePath: null, activeBranch, key, ambiguous: false, resolvedBy: null, candidates: [] }
  }

  if (matches.length === 1) {
    return {
      workspacePath: matches[0].path,
      activeBranch,
      key,
      ambiguous: false,
      resolvedBy: focusedPath ? 'terminal' : 'unique',
      candidates: []
    }
  }

  if (focusedPath) {
    const exact = matches.find((w) => w.path === focusedPath)
    if (exact) {
      return { workspacePath: exact.path, activeBranch, key, ambiguous: false, resolvedBy: 'terminal', candidates: [] }
    }
    const focusedProject = focusedPath.split(/[/\\]+/).filter(Boolean).pop()
    if (focusedProject) {
      const fpLower = focusedProject.toLowerCase()
      const byProjectMatch = matches.find(
        (w) =>
          (w.project && w.project.toLowerCase() === fpLower) ||
          (w.name && w.name.toLowerCase() === fpLower) ||
          w.path.toLowerCase().endsWith('/' + fpLower)
      )
      if (byProjectMatch) {
        return { workspacePath: byProjectMatch.path, activeBranch, key, ambiguous: false, resolvedBy: 'terminal', candidates: [] }
      }
    }
  }

  if (focused && matches.some((w) => w.path === focused.path)) {
    return { workspacePath: focused.path, activeBranch, key, ambiguous: false, resolvedBy: 'terminal', candidates: [] }
  }

  // A hint or a pick is a guess about which workspace is focused, so the picker stays up to correct it.
  const labels = candidateLabels(matches.map((w) => w.path))
  const candidates = matches.map((w, i) => ({ path: w.path, name: labels[i] }))
  const hinted = hintPath ? matches.find((w) => w.path === hintPath) : undefined
  if (hinted) {
    return { workspacePath: hinted.path, activeBranch, key, ambiguous: true, resolvedBy: 'hint', candidates }
  }
  const picked = matches.find((w) => w.path === choices.get(key))
  return {
    workspacePath: (picked ?? matches[0]).path,
    activeBranch,
    key,
    ambiguous: true,
    resolvedBy: picked ? 'pick' : null,
    candidates
  }
}

function recordTerminalOwner(state: WorkerState, payload: unknown): void {
  const event = payload as { workspaceId?: unknown; terminalId?: unknown } | null
  if (typeof event?.workspaceId === 'string' && typeof event.terminalId === 'string' && event.terminalId.length > 0) {
    rememberBounded(state.terminalOwners, event.terminalId, event.workspaceId)
  }
}

function focusKey(context: FocusedContext | null): string {
  const ids = (Array.isArray(context?.terminals) ? context.terminals : [])
    .map((t) => (typeof t?.id === 'string' ? t.id : ''))
    .sort()
  return JSON.stringify([context?.branch ?? null, context?.displayName ?? null, ids])
}

/** The workspace a focused terminal belongs to, when agent events have tied its terminal to one. */
function focusedWorkspace(
  context: FocusedContext | null,
  workspaces: WorkspaceEntry[],
  terminalOwners: Map<string, string>
): WorkspaceEntry | null {
  for (const terminal of context?.terminals ?? []) {
    const id = typeof terminal?.id === 'string' ? terminal.id : null
    const workspaceId = id ? terminalOwners.get(id) : undefined
    if (!workspaceId) continue
    const workspace = workspaces.find((w) => w.id === workspaceId)
    if (workspace) return workspace
  }
  return null
}

export async function collectRepoContext(
  orca: OrcaWorkerApi,
  state: WorkerState = createWorkerState(),
  options: { hintPath?: string | null } = {}
): Promise<RepoContext> {
  const requestedAt = Math.max(Date.now(), state.lastRequestedAt + 1)
  state.lastRequestedAt = requestedAt
  let workspacePath: string | null = null
  let activeBranch: string | null = null
  let contextCandidates: RepoCandidate[] | undefined
  let ambiguous = false
  let resolvedBy: ResolvedBy = null
  let startFocus: string | null = null
  let resolveError: string | null = null
  const hintPath = typeof options.hintPath === 'string' && options.hintPath.length > 0 ? options.hintPath : null

  try {
    const context = await orca.host.call('workspace.readContext')
    startFocus = focusKey(context)
    if (context?.branch) activeBranch = stripRef(context.branch)
    const list = await orca.host.call('workspace.list')
    const workspaces = (list?.workspaces ?? []) as WorkspaceEntry[]
    let resolution = resolveWorkspace(context, workspaces, state.sessionChoices, state.terminalOwners)
    if (resolution.ambiguous) {
      let focusedPath: string | null = null
      const focusedTerminalIds = (Array.isArray(context?.terminals) ? context.terminals : [])
        .map((t) => (typeof t?.id === 'string' ? t.id : ''))
        .filter(Boolean)
      for (const id of focusedTerminalIds.slice(0, 3)) {
        focusedPath = await lookupFocusedPath(state, id)
        if (focusedPath) break
      }
      if (!focusedPath && focusedTerminalIds.length === 0) {
        focusedPath = await lookupActiveRemoteWorktree(state, workspaces, activeBranch)
      }
      await pruneChoices(orca, state)
      resolution = resolveWorkspace(context, workspaces, await readChoices(orca, state), state.terminalOwners, focusedPath, hintPath)
      contextCandidates = resolution.candidates
    }
    workspacePath = resolution.workspacePath
    ambiguous = resolution.ambiguous
    resolvedBy = resolution.resolvedBy
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

  let focusMoved = true
  if (startFocus !== null) {
    try {
      focusMoved = focusKey(await orca.host.call('workspace.readContext')) !== startFocus
    } catch {
      // unreadable now, so this context cannot vouch for the current focus
    }
  }

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
    candidates: contextCandidates,
    resolvedBy,
    focusMoved
  }

  return result
}

/** Inert in production; tests hold a collect at the publish window to stage an interleaving. */
export const testHooks: {
  beforePublish: ((context: RepoContext) => Promise<void>) | null
  afterChoicesRead: (() => Promise<void>) | null
  execOrca: ((cli: string, args: string[]) => Promise<{ stdout: string }>) | null
} = { beforePublish: null, afterChoicesRead: null, execOrca: null }

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

  orca.panels.handle('repo.getContext', async (input: { hintPath?: unknown } | undefined) => {
    const hintPath = typeof input?.hintPath === 'string' ? input.hintPath : null
    const context = await collectRepoContext(orca, state, { hintPath })
    return publish(orca, state, context)
  })

  orca.panels.handle('repo.chooseWorkspace', async (input: { path?: string }) => {
    const path = typeof input?.path === 'string' ? input.path : null
    if (path) {
      try {
        const context = await orca.host.call('workspace.readContext')
        const list = await orca.host.call('workspace.list')
        const resolution = resolveWorkspace(context, (list?.workspaces ?? []) as WorkspaceEntry[], state.sessionChoices, state.terminalOwners)
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

  // Correlate agent terminals with workspaces: agent.status.changed is the only plugin-visible
  // signal that carries both terminalId and workspaceId, and readContext carries terminal ids.
  orca.events.on('agent.status.changed', (payload: unknown) => {
    recordTerminalOwner(state, payload)
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
