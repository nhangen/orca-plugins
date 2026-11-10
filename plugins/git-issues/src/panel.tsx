// Declarative TSX sidebar panel rendered natively by Orca.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  Heading,
  IconButton,
  Input,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  shell,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import type { GitBranch, GitIssue, RepoContext } from './protocol'

// Atoms for state management
export const repoContext = atom<RepoContext | null>(null)
export const loading = atom<boolean>(true)
export const activeTab = atom<string>('activeTab', 'issues', { persist: 'plugin' })
export const issueFilter = atom<string>('issueFilter', 'open', { persist: 'plugin' })
export const issueSearch = atom<string>('')
export const branchSearch = atom<string>('')

export async function refresh(force = true): Promise<void> {
  set(loading, true)
  try {
    const data = await plugin.request('repo.getContext', { forceRefresh: force })
    set(repoContext, data)
  } catch (err: any) {
    // If request fails, keep whatever state exists
  } finally {
    set(loading, false)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('repo.changed', (data) => {
      set(repoContext, data)
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
  const issueQuery = read(issueSearch).toLowerCase().trim()
  const branchQuery = read(branchSearch).toLowerCase().trim()

  const allIssues: GitIssue[] = data?.issues ?? []
  const allBranches: GitBranch[] = data?.branches ?? []

  const openCount = allIssues.filter((i) => i.state === 'OPEN').length
  const closedCount = allIssues.filter((i) => i.state === 'CLOSED').length

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

  const filteredBranches = allBranches.filter((branch) => {
    if (!branchQuery) return true
    const matchName = branch.name.toLowerCase().includes(branchQuery)
    const matchSubject = branch.lastCommitSubject?.toLowerCase().includes(branchQuery) ?? false
    return matchName || matchSubject
  })

  const repoTitle = data?.repoSlug ?? (data?.workspacePath ? data.workspacePath.split('/').pop() : 'Repository')

  return (
    <Stack gap="md">
      {/* Header */}
      <Row justify="between" align="center">
        <Stack gap="xs">
          <Heading level={2}>{repoTitle}</Heading>
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
          onPress={() => void refresh(true)}
          disabled={isLoading}
        />
      </Row>

      {/* Tabs */}
      <Tabs label="Views" value={currentTab} onChange={(t) => set(activeTab, t)}>
        <Tab value="issues" label={`Issues (${openCount})`} icon="bug">
          <Stack gap="sm">
            {/* Filter buttons */}
            <Row gap="xs" align="center" justify="between">
              <Row gap="xs">
                <Button
                  size="xs"
                  variant={currentIssueFilter === 'open' ? 'solid' : 'ghost'}
                  tone={currentIssueFilter === 'open' ? 'accent' : 'neutral'}
                  onPress={() => set(issueFilter, 'open')}
                >
                  {`Open (${openCount})`}
                </Button>
                <Button
                  size="xs"
                  variant={currentIssueFilter === 'closed' ? 'solid' : 'ghost'}
                  tone={currentIssueFilter === 'closed' ? 'accent' : 'neutral'}
                  onPress={() => set(issueFilter, 'closed')}
                >
                  {`Closed (${closedCount})`}
                </Button>
                <Button
                  size="xs"
                  variant={currentIssueFilter === 'all' ? 'solid' : 'ghost'}
                  tone={currentIssueFilter === 'all' ? 'neutral' : 'neutral'}
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
                      title={`#${issue.number} ${issue.title}`}
                      description={issue.author ? `Opened by ${issue.author}` : undefined}
                      icon={issue.state === 'OPEN' ? 'bug' : 'check'}
                      onPress={() => void shell.openExternal(issue.url)}
                    >
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

        <Tab value="branches" label={`Branches (${allBranches.length})`} icon="branch">
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
                      title={branch.name}
                      description={branch.lastCommitSubject || undefined}
                      icon="branch"
                      current={branch.isHead}
                    >
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
