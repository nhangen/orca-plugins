// The plugin's own worker running in Node.js on the Orca host.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'
import type { GitBranch, GitIssue, RepoContext } from './protocol'

const exec = promisify(execFile)
const STORAGE_KEY = 'latestContext'

const EXEC_ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`
}

export function parseGitRemote(url: string): string | null {
  const trimmed = url.trim()
  const match = trimmed.match(/[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/)
  if (!match) return null
  return `${match[1]}/${match[2]}`
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

export async function collectRepoContext(orca: OrcaWorkerApi): Promise<RepoContext> {
  let workspacePath: string | null = null
  let activeBranch: string | null = null

  try {
    const context = await orca.host.call('workspace.readContext')
    if (context?.branch) {
      activeBranch = context.branch.replace(/^refs\/heads\//, '')
    }

    const list = await orca.host.call('workspace.list')
    if (list?.workspaces && list.workspaces.length > 0) {
      const match = list.workspaces.find(
        (w) =>
          (activeBranch && w.branch && w.branch.replace(/^refs\/heads\//, '') === activeBranch) ||
          (context?.displayName && w.name === context.displayName)
      )
      workspacePath = match?.path ?? list.workspaces[0].path
    }
  } catch {
    // If workspace calls fail (e.g. testing or permission), fallback
  }

  if (!workspacePath) {
    workspacePath = process.cwd()
  }

  let branches: GitBranch[] = []
  let branchesError: string | null = null
  let detectedHead: string | null = null

  try {
    const { stdout } = await exec(
      'git',
      ['branch', '--list', '--format=%(refname:short)|%(HEAD)|%(upstream:short)|%(subject)|%(committerdate:iso)'],
      { cwd: workspacePath, env: EXEC_ENV }
    )
    const parsed = parseGitBranches(stdout)
    branches = parsed.branches
    detectedHead = parsed.currentBranch
  } catch (err: any) {
    branchesError = `Git branch error: ${err?.message || String(err)}`
  }

  const currentBranch = detectedHead ?? activeBranch

  let repoSlug: string | null = null
  try {
    const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: workspacePath, env: EXEC_ENV })
    repoSlug = parseGitRemote(stdout)
  } catch {
    // No git remote origin
  }

  let issues: GitIssue[] = []
  let issuesError: string | null = null

  if (repoSlug) {
    const issuesResult = await fetchGitHubIssues(repoSlug, workspacePath)
    issues = issuesResult.issues
    if (issuesResult.error) {
      issuesError = issuesResult.error
    }
  } else {
    issuesError = 'No GitHub remote origin found for this workspace'
  }

  const result: RepoContext = {
    repoSlug,
    currentBranch,
    workspacePath,
    issues,
    branches,
    issuesError,
    branchesError,
    fetchedAt: Date.now()
  }

  return result
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('repo.getContext', async () => {
    const context = await collectRepoContext(orca)
    const sanitized = JSON.parse(JSON.stringify(context))
    try {
      await orca.storage.set(STORAGE_KEY, sanitized)
    } catch {
      // storage cache save is non-blocking
    }
    orca.panels.post('repo.changed', sanitized)
    return sanitized
  })

  // Whenever focused workspace or terminals change in Orca, refresh
  orca.events.on('workspace.changed', async () => {
    try {
      const context = await collectRepoContext(orca)
      const sanitized = JSON.parse(JSON.stringify(context))
      try {
        await orca.storage.set(STORAGE_KEY, sanitized)
      } catch {
        // storage cache save is non-blocking
      }
      orca.panels.post('repo.changed', sanitized)
    } catch {
      // ignore background refresh errors
    }
  })
}
