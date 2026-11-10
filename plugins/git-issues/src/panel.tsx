// Declarative TSX sidebar panel rendered natively by Orca.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  IconButton,
  Input,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  shell,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import type { GitBranch, GitIssue, GitPullRequest, RepoContext } from './protocol'

// Atoms for state management
export const repoContext = atom<RepoContext | null>(null)
export const loading = atom<boolean>(true)
export const activeTab = atom<string>('activeTab', 'issues', { persist: 'plugin' })
export const issueFilter = atom<string>('issueFilter', 'open', { persist: 'plugin' })
export const issueSearch = atom<string>('')
export const prFilter = atom<string>('prFilter', 'open', { persist: 'plugin' })
export const prSearch = atom<string>('')
export const branchSearch = atom<string>('')

/** A slower, earlier collect can finish last, so contexts are ordered by when they were requested. */
function applyContext(data: RepoContext): void {
  const current = read(repoContext)
  if (!current || data.requestedAt >= current.requestedAt) set(repoContext, data)
}

export async function refresh(force = true): Promise<void> {
  set(loading, true)
  try {
    applyContext(await plugin.request('repo.getContext', { forceRefresh: force }))
  } catch (err: any) {
    // If request fails, keep whatever state exists
  } finally {
    set(loading, false)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('repo.changed', (data) => {
      applyContext(data)
      set(loading, false)
    })
  )
  void refresh(false)
}

export default function Panel() {
  const data = read(repoContext)
  const isLoading = read(loading)
  const currentTab = read(activeTab)
  const currentIssueFilter = read(issueFilter)
  const currentPrFilter = read(prFilter)
  const issueQuery = read(issueSearch).toLowerCase().trim()
  const prQuery = read(prSearch).toLowerCase().trim()
  const branchQuery = read(branchSearch).toLowerCase().trim()

  const allIssues: GitIssue[] = data?.issues ?? []
  const allPRs: GitPullRequest[] = data?.pullRequests ?? []
  const allBranches: GitBranch[] = data?.branches ?? []

  const openCount = allIssues.filter((i) => i.state === 'OPEN').length
  const closedCount = allIssues.filter((i) => i.state === 'CLOSED').length

  const openPRCount = allPRs.filter((p) => p.state === 'OPEN' && !p.isDraft).length
  const draftPRCount = allPRs.filter((p) => p.isDraft).length
  const mergedPRCount = allPRs.filter((p) => p.state === 'MERGED').length
  const closedPRCount = allPRs.filter((p) => p.state === 'CLOSED' && !p.isDraft).length

  const filteredIssues = allIssues.filter((issue) => {
    if (currentIssueFilter === 'open' && issue.state !== 'OPEN') return false
    if (currentIssueFilter === 'closed' && issue.state !== 'CLOSED') return false
    if (issueQuery) {
      const matchTitle = issue.title.toLowerCase().includes(issueQuery)
      const matchNum = String(issue.number).includes(issueQuery)
      const matchAuthor = issue.author?.toLowerCase().includes(issueQuery) ?? false
      return matchTitle || matchNum || matchAuthor
    }
    return true
  })

  const filteredPRs = allPRs.filter((pr) => {
    if (currentPrFilter === 'open' && (pr.state !== 'OPEN' || pr.isDraft)) return false
    if (currentPrFilter === 'draft' && !pr.isDraft) return false
    if (currentPrFilter === 'merged' && pr.state !== 'MERGED') return false
    if (currentPrFilter === 'closed' && (pr.state !== 'CLOSED' || pr.isDraft)) return false
    if (prQuery) {
      const matchTitle = pr.title.toLowerCase().includes(prQuery)
      const matchNum = String(pr.number).includes(prQuery)
      const matchAuthor = pr.author?.toLowerCase().includes(prQuery) ?? false
      const matchHead = pr.headRefName?.toLowerCase().includes(prQuery) ?? false
      return matchTitle || matchNum || matchAuthor || matchHead
    }
    return true
  })

  const filteredBranches = allBranches.filter((branch) => {
    if (!branchQuery) return true
    const matchName = branch.name.toLowerCase().includes(branchQuery)
    const matchSubject = branch.lastCommitSubject?.toLowerCase().includes(branchQuery) ?? false
    return matchName || matchSubject
  })

  const repoTitle = data?.repoSlug ?? (data?.workspacePath ? data.workspacePath.split('/').pop() : 'Repository')

  const candidates = data?.candidates ?? []
  const ambiguous = Boolean(data?.ambiguous) && candidates.length > 1

  const chooseCandidate = (path: string): void => {
    const choose = async (): Promise<void> => {
      try {
        applyContext(await plugin.request('repo.chooseWorkspace', { path }))
      } catch {
        // keep the previous context if the worker cannot answer
      }
    }
    void choose()
  }

  return (
    <Stack gap="md">
      {/* Header */}
      <Row justify="between" align="center">
        <Stack gap="xs">
          <Text size="xs" weight="semibold">{repoTitle}</Text>
          {data?.currentBranch ? (
            <Row gap="xs" align="center">
              <Badge tone="accent">{data.currentBranch}</Badge>
              {data.fetchedAt ? (
                <Text size="xs" muted>
                  updated <RelativeTime at={data.fetchedAt} />
                </Text>
              ) : null}
            </Row>
          ) : null}
        </Stack>
        <IconButton
          icon="refresh"
          label="Refresh repository context"
          size="xs"
          onPress={() => void refresh(true)}
          disabled={isLoading}
        />
      </Row>

      {/* Ambiguous workspace picker: several repos share this branch and name. */}
      {ambiguous ? (
        <Select
          label={`Several workspaces are on ${data?.currentBranch ?? 'this branch'}; Orca does not expose which is focused`}
          value={data?.workspacePath ?? undefined}
          options={candidates.map((c) => ({ value: c.path, label: c.name }))}
          onChange={chooseCandidate}
        />
      ) : null}

      {/* Tabs */}
      <Tabs label="Views" value={currentTab} onChange={(t) => set(activeTab, t)}>
        <Tab value="issues" label={`Issues (${openCount})`}>
          <Stack gap="sm">
            {/* Filter buttons */}
            <Row gap="xs" align="center" justify="between">
              <Row gap="xs">
                <Button
                  size="xs"
                  variant={currentIssueFilter === 'open' ? 'solid' : 'ghost'}
                  tone="neutral"
                  onPress={() => set(issueFilter, 'open')}
                >
                  {`Open (${openCount})`}
                </Button>
                <Button
                  size="xs"
                  variant={currentIssueFilter === 'closed' ? 'solid' : 'ghost'}
                  tone="neutral"
                  onPress={() => set(issueFilter, 'closed')}
                >
                  {`Closed (${closedCount})`}
                </Button>
                <Button
                  size="xs"
                  variant={currentIssueFilter === 'all' ? 'solid' : 'ghost'}
                  tone="neutral"
                  onPress={() => set(issueFilter, 'all')}
                >
                  {`All (${allIssues.length})`}
                </Button>
              </Row>
            </Row>

            {/* Issue Search input */}
            <Input
              label="Search issues"
              labelHidden
              type="search"
              placeholder="Filter by title, #, or author..."
              value={read(issueSearch)}
              onChange={(val) => set(issueSearch, val)}
            />

            {/* Issue content */}
            {isLoading && !data ? (
              <Spinner label="Loading issues..." />
            ) : data?.issuesError ? (
              <Callout tone="warning" title="Issues Notice" icon="warning">
                {data.issuesError}
              </Callout>
            ) : filteredIssues.length === 0 ? (
              <EmptyState
                title="No issues found"
                description={issueQuery ? 'No issues match your filter.' : 'No issues found for this repository.'}
                icon="check"
              />
            ) : (
              <Box scroll="y">
                <List label="GitHub Issues">
                  {filteredIssues.map((issue) => (
                    <ListItem
                      key={String(issue.number)}
                      icon={issue.state === 'OPEN' ? 'bug' : 'check'}
                      onPress={() => void shell.openExternal(issue.url)}
                    >
                      <Text size="xs" weight="medium" truncate>
                        {`#${issue.number} ${issue.title}`}
                      </Text>
                      {issue.author ? (
                        <Text size="xs" muted truncate>
                          {`Opened by ${issue.author}`}
                        </Text>
                      ) : null}
                      <Row gap="xs" align="center" wrap>
                        <Badge tone={issue.state === 'OPEN' ? 'accent' : 'neutral'}>
                          {issue.state.toLowerCase()}
                        </Badge>
                        {issue.labels?.map((label) => (
                          <Badge key={label.name} tone="neutral">
                            {label.name}
                          </Badge>
                        ))}
                        {issue.updatedAtMs ? (
                          <Text size="xs" muted>
                            <RelativeTime at={issue.updatedAtMs} />
                          </Text>
                        ) : null}
                      </Row>
                    </ListItem>
                  ))}
                </List>
              </Box>
            )}
          </Stack>
        </Tab>

        <Tab value="prs" label={`PRs (${openPRCount + draftPRCount})`}>
          <Stack gap="sm">
            {/* PR filter buttons */}
            <Row gap="xs" align="center" wrap>
              <Button
                size="xs"
                variant={currentPrFilter === 'open' ? 'solid' : 'ghost'}
                tone="neutral"
                onPress={() => set(prFilter, 'open')}
              >
                {`Open (${openPRCount})`}
              </Button>
              <Button
                size="xs"
                variant={currentPrFilter === 'draft' ? 'solid' : 'ghost'}
                tone="neutral"
                onPress={() => set(prFilter, 'draft')}
              >
                {`Draft (${draftPRCount})`}
              </Button>
              <Button
                size="xs"
                variant={currentPrFilter === 'merged' ? 'solid' : 'ghost'}
                tone="neutral"
                onPress={() => set(prFilter, 'merged')}
              >
                {`Merged (${mergedPRCount})`}
              </Button>
              <Button
                size="xs"
                variant={currentPrFilter === 'closed' ? 'solid' : 'ghost'}
                tone="neutral"
                onPress={() => set(prFilter, 'closed')}
              >
                {`Closed (${closedPRCount})`}
              </Button>
              <Button
                size="xs"
                variant={currentPrFilter === 'all' ? 'solid' : 'ghost'}
                tone="neutral"
                onPress={() => set(prFilter, 'all')}
              >
                {`All (${allPRs.length})`}
              </Button>
            </Row>

            {/* PR Search input */}
            <Input
              label="Search pull requests"
              labelHidden
              type="search"
              placeholder="Filter by title, #, branch, or author..."
              value={read(prSearch)}
              onChange={(val) => set(prSearch, val)}
            />

            {/* PR content */}
            {isLoading && !data ? (
              <Spinner label="Loading pull requests..." />
            ) : data?.prsError ? (
              <Callout tone="warning" title="Pull Requests Notice" icon="warning">
                {data.prsError}
              </Callout>
            ) : filteredPRs.length === 0 ? (
              <EmptyState
                title="No pull requests found"
                description={prQuery ? 'No pull requests match your filter.' : 'No pull requests found for this repository.'}
                icon="check"
              />
            ) : (
              <Box scroll="y">
                <List label="Pull Requests">
                  {filteredPRs.map((pr) => (
                    <ListItem
                      key={String(pr.number)}
                      icon={pr.state === 'MERGED' ? 'check' : pr.isDraft ? 'file-text' : pr.state === 'OPEN' ? 'branch' : 'close'}
                      onPress={() => void shell.openExternal(pr.url)}
                    >
                      <Text size="xs" weight="medium" truncate>
                        {`#${pr.number} ${pr.title}`}
                      </Text>
                      {pr.headRefName ? (
                        <Text size="xs" muted truncate>
                          {`${pr.author ? `Opened by ${pr.author} · ` : ''}${pr.headRefName} → ${pr.baseRefName ?? 'main'}`}
                        </Text>
                      ) : pr.author ? (
                        <Text size="xs" muted truncate>
                          {`Opened by ${pr.author}`}
                        </Text>
                      ) : null}
                      <Row gap="xs" align="center" wrap>
                        <Badge tone={pr.isDraft ? 'neutral' : pr.state === 'OPEN' ? 'accent' : 'neutral'}>
                          {pr.isDraft ? 'draft' : pr.state.toLowerCase()}
                        </Badge>
                        {pr.labels?.map((label) => (
                          <Badge key={label.name} tone="neutral">
                            {label.name}
                          </Badge>
                        ))}
                        {pr.updatedAtMs ? (
                          <Text size="xs" muted>
                            <RelativeTime at={pr.updatedAtMs} />
                          </Text>
                        ) : null}
                      </Row>
                    </ListItem>
                  ))}
                </List>
              </Box>
            )}
          </Stack>
        </Tab>

        <Tab value="branches" label={`Branches (${allBranches.length})`}>
          <Stack gap="sm">
            {/* Branch search input */}
            <Input
              label="Search branches"
              labelHidden
              type="search"
              placeholder="Filter branches..."
              value={read(branchSearch)}
              onChange={(val) => set(branchSearch, val)}
            />

            {/* Branch content */}
            {isLoading && !data ? (
              <Spinner label="Loading branches..." />
            ) : data?.branchesError ? (
              <Callout tone="warning" title="Branches Notice" icon="warning">
                {data.branchesError}
              </Callout>
            ) : filteredBranches.length === 0 ? (
              <EmptyState
                title="No branches found"
                description="No git branches match your filter."
                icon="branch"
              />
            ) : (
              <Box scroll="y">
                <List label="Git Branches">
                  {filteredBranches.map((branch) => (
                    <ListItem
                      key={branch.name}
                      icon="branch"
                      current={branch.isHead}
                    >
                      <Text size="xs" weight="medium" truncate>
                        {branch.name}
                      </Text>
                      {branch.lastCommitSubject ? (
                        <Text size="xs" muted truncate>
                          {branch.lastCommitSubject}
                        </Text>
                      ) : null}
                      <Row gap="xs" align="center" wrap>
                        {branch.isHead ? <Badge tone="accent">HEAD</Badge> : null}
                        {branch.upstream ? (
                          <Text size="xs" muted>
                            tracking {branch.upstream}
                          </Text>
                        ) : null}
                        {branch.lastCommitDate ? (
                          <Text size="xs" muted>
                            {branch.lastCommitDate.split(' ')[0]}
                          </Text>
                        ) : null}
                      </Row>
                    </ListItem>
                  ))}
                </List>
              </Box>
            )}
          </Stack>
        </Tab>
      </Tabs>
    </Stack>
  )
}
