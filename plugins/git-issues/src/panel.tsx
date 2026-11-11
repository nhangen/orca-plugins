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
  Link,
  List,
  ListItem,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  shell,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Text,
  type IconName,
  type OrcaNode,
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

/**
 * The path this workspace was last resolved to, persisted per workspace by Orca itself: written
 * when a focused terminal identified the workspace or the user picked one, and sent back to the
 * worker as a hint that preselects the picker when the focus is ambiguous again.
 */
export const lastResolvedPath = atom<string | null>('lastResolvedPath', null, { persist: 'workspace' })

function currentHint(): string | undefined {
  return read(lastResolvedPath) ?? undefined
}

/** A slower, earlier collect can finish last, so contexts are ordered by when they were requested. */
function applyContext(data: RepoContext, sentHint = false): void {
  const current = read(repoContext)
  if (current && data.workerEpoch === current.workerEpoch && data.requestedAt < current.requestedAt) return
  set(repoContext, data)
  if (data.resolvedBy === 'terminal' && !data.focusMoved && data.workspacePath) {
    set(lastResolvedPath, data.workspacePath)
  }
  if (sentHint || !data.ambiguous || data.resolvedBy === 'hint') return
  const hint = currentHint()
  if (hint && hint !== data.workspacePath && (data.candidates ?? []).some((c) => c.path === hint)) {
    void plugin
      .request('repo.getContext', { hintPath: hint })
      .then((fresh) => applyContext(fresh, true))
      .catch(() => {})
  }
}

export async function refresh(force = true): Promise<void> {
  set(loading, true)
  try {
    const hintPath = currentHint()
    applyContext(await plugin.request('repo.getContext', hintPath ? { forceRefresh: force, hintPath } : { forceRefresh: force }), true)
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

function openUrl(url: string): void {
  void shell.openExternal(url)
}

function compareUrl(repoSlug: string, branch: string): string {
  return `https://github.com/${repoSlug}/compare/${branch.split('/').map(encodeURIComponent).join('/')}?expand=1`
}

/** Only an `origin/…` upstream is known to live in `repoSlug`'s repo. */
export function branchUrl(repoSlug: string | null | undefined, branch: GitBranch): string | undefined {
  const remoteBranch = branch.upstream?.startsWith('origin/') ? branch.upstream.slice('origin/'.length) : undefined
  if (!repoSlug || !remoteBranch) return undefined
  return `https://github.com/${repoSlug}/tree/${remoteBranch.split('/').map(encodeURIComponent).join('/')}`
}

function matches(query: string, ...fields: (string | number | undefined)[]): boolean {
  return !query || fields.some((f) => f !== undefined && String(f).toLowerCase().includes(query))
}

type IssueKind = 'security' | 'bug' | 'feature' | 'idea' | 'task' | 'docs' | 'question'

const KIND_PRECEDENCE: readonly IssueKind[] = ['security', 'bug', 'feature', 'idea', 'task', 'docs', 'question']

const KIND_ICON: Record<IssueKind, IconName> = {
  security: 'error',
  bug: 'bug',
  feature: 'rocket',
  idea: 'lightbulb',
  task: 'hammer',
  docs: 'layers',
  question: 'puzzle'
}

const KIND_WORDS: Record<string, IssueKind> = {
  security: 'security', urgent: 'security', critical: 'security', vulnerability: 'security',
  bug: 'bug', defect: 'bug', regression: 'bug',
  feature: 'feature', feat: 'feature', enhancement: 'feature', 'feature request': 'feature',
  idea: 'idea', proposal: 'idea',
  task: 'task', chore: 'task', maintenance: 'task', refactor: 'task',
  docs: 'docs', doc: 'docs', documentation: 'docs',
  question: 'question', discussion: 'question', discuss: 'question'
}

const TITLE_PREFIX = /^\s*([a-z]+)(?:\([^)]*\))?!?\s*:/i

function kindOfLabel(name: string): IssueKind | undefined {
  const word = name.trim().toLowerCase().replace(/^(?:type|kind)\s*[:/]\s*/, '')
  return KIND_WORDS[word]
}

/** Labels decide first (most severe wins); otherwise an exact `Word:` title prefix; otherwise neutral. */
export function issueIcon(issue: Pick<GitIssue, 'title' | 'labels'>): IconName {
  const fromLabels = new Set((issue.labels ?? []).map((l) => kindOfLabel(l.name)))
  const labelled = KIND_PRECEDENCE.find((k) => fromLabels.has(k))
  if (labelled) return KIND_ICON[labelled]
  const prefix = TITLE_PREFIX.exec(issue.title)?.[1]?.toLowerCase()
  const titled = prefix ? KIND_WORDS[prefix] : undefined
  return titled ? KIND_ICON[titled] : 'plug'
}

function prIcon(pr: GitPullRequest): IconName {
  if (pr.state === 'MERGED') return 'check'
  if (pr.state === 'CLOSED') return 'close'
  return pr.isDraft ? 'file-text' : 'branch'
}

function prStateLabel(pr: GitPullRequest): string {
  if (pr.isDraft && pr.state === 'OPEN') return 'Draft'
  return pr.state.charAt(0) + pr.state.slice(1).toLowerCase()
}

/** The open PR for a branch, else its most recent closed or merged one. */
export function pullRequestFor(prs: GitPullRequest[], branch: string | null | undefined): GitPullRequest | undefined {
  if (!branch) return undefined
  const forBranch = prs.filter((p) => p.headRefName === branch)
  return forBranch.find((p) => p.state === 'OPEN') ?? forBranch[0]
}

/** `#42 · 5h · 3 comments`: one muted line, so the separators carry the spacing. */
function Meta(props: { number?: number; at?: number; extra?: string; date?: string }): OrcaNode {
  const parts: OrcaNode[] = []
  if (props.number !== undefined) parts.push(`#${props.number}`)
  if (props.at) parts.push(<RelativeTime at={props.at} format="duration" />)
  if (props.date) parts.push(props.date)
  if (props.extra) parts.push(props.extra)
  return (
    <Text size="xs" muted>
      {parts.flatMap((part, i) => (i === 0 ? [part] : [' · ', part]))}
    </Text>
  )
}

/** The row's title; a link only when there is a page to open, so the row itself never is one. */
function Title(props: { text: string; url?: string; size?: 'xs' | 'sm' }): OrcaNode {
  const { url } = props
  return (
    <Text size={props.size ?? 'xs'} weight="medium" truncate>
      {url ? <Link onPress={() => openUrl(url)}>{props.text}</Link> : props.text}
    </Text>
  )
}

/** A list row whose icon opens the same page as its title; ListItem's own icon can't be pressed. */
function LinkedRow(props: { icon: IconName; url?: string; label: string; current?: boolean; children: OrcaNode }): OrcaNode {
  const { url } = props
  if (!url) return <ListItem icon={props.icon} current={props.current}>{props.children}</ListItem>
  return (
    <ListItem current={props.current}>
      <Row gap="sm" align="start">
        <IconButton icon={props.icon} size="xs" variant="ghost" label={`Open on GitHub: ${props.label}`} onPress={() => openUrl(url)} />
        <Box grow>
          <Stack gap="xs">{props.children}</Stack>
        </Box>
      </Row>
    </ListItem>
  )
}

function Labels({ labels }: { labels: { name: string }[] }): OrcaNode {
  return <>{labels.map((label) => <Badge key={label.name} tone="neutral">{label.name}</Badge>)}</>
}

function Toolbar(props: {
  search: string
  searchLabel: string
  placeholder: string
  onSearch: (value: string) => void
  filterLabel?: string
  filter?: string
  filterOptions?: { value: string; label: string }[]
  onFilter?: (value: string) => void
}): OrcaNode {
  return (
    <Box direction="row" gap="xs" align="center">
      <Box grow>
        <Input
          label={props.searchLabel}
          labelHidden
          type="search"
          placeholder={props.placeholder}
          value={props.search}
          onChange={props.onSearch}
        />
      </Box>
      {props.filterOptions && props.filterLabel ? (
        <Box shrink={false}>
          <Select
            label={props.filterLabel}
            labelHidden
            value={props.filter}
            options={props.filterOptions}
            onChange={props.onFilter}
          />
        </Box>
      ) : null}
    </Box>
  )
}

function ListBody(props: {
  loading: boolean
  noun: string
  error?: string | null
  count: number
  query: string
  emptyIcon: IconName
  onClear: () => void
  children: OrcaNode
}): OrcaNode {
  if (props.loading) return <Skeleton shape="text" lines={5} label={`Loading ${props.noun}`} />
  if (props.error) {
    return (
      <Callout tone="warning" title={`Can't load ${props.noun}`} icon="warning">
        <Stack gap="sm" align="start">
          <Text size="xs">{props.error}</Text>
          <Button size="xs" variant="outline" icon="refresh" onPress={() => void refresh(true)}>
            Retry
          </Button>
        </Stack>
      </Callout>
    )
  }
  if (props.count === 0) {
    return props.query ? (
      <EmptyState title="Nothing matches" description={`No ${props.noun} match “${props.query}”.`} icon="search">
        <Button size="xs" variant="ghost" onPress={props.onClear}>
          Clear filter
        </Button>
      </EmptyState>
    ) : (
      <EmptyState title={`No ${props.noun}`} icon={props.emptyIcon} />
    )
  }
  return <Box scroll="y">{props.children}</Box>
}

function CurrentBranchCard(props: { data: RepoContext }): OrcaNode {
  const { data } = props
  const branch = data.currentBranch
  if (!branch) return null
  const local = data.branches.find((b) => b.name === branch)
  const pr = pullRequestFor(data.pullRequests, branch)
  const pushed = Boolean(local?.upstream)
  const treeUrl = local ? branchUrl(data.repoSlug, local) : undefined
  return (
    <Box border radius="md" background="card">
      <List label="Current branch">
        <LinkedRow icon="branch" url={treeUrl} label={branch}>
          <Title size="sm" text={branch} url={treeUrl} />
          <Text size="xs" muted>{pushed ? `Tracking ${local!.upstream}` : 'Local only, not pushed'}</Text>
        </LinkedRow>
        {pr ? (
          <LinkedRow icon={prIcon(pr)} url={pr.url} label={pr.title}>
            <Title size="sm" text={pr.title} url={pr.url} />
            <Text size="xs" muted>{`#${pr.number} · ${prStateLabel(pr)}`}</Text>
          </LinkedRow>
        ) : data.repoSlug && !data.prsError ? (
          <LinkedRow icon="add" url={compareUrl(data.repoSlug, branch)} label="Open a pull request">
            <Title size="sm" text="Open a pull request" url={compareUrl(data.repoSlug, branch)} />
            <Text size="xs" muted>{pushed ? 'No pull request for this branch' : 'Push the branch first'}</Text>
          </LinkedRow>
        ) : null}
      </List>
    </Box>
  )
}

export default function Panel() {
  const data = read(repoContext)
  const isLoading = read(loading)
  const currentTab = read(activeTab)
  const currentIssueFilter = read(issueFilter)
  const currentPrFilter = read(prFilter)
  const issueText = read(issueSearch)
  const prText = read(prSearch)
  const branchText = read(branchSearch)
  const issueQuery = issueText.toLowerCase().trim()
  const prQuery = prText.toLowerCase().trim()
  const branchQuery = branchText.toLowerCase().trim()
  const firstLoad = isLoading && !data

  const allIssues: GitIssue[] = data?.issues ?? []
  const allPRs: GitPullRequest[] = data?.pullRequests ?? []
  const allBranches: GitBranch[] = data?.branches ?? []
  const currentBranch = data?.currentBranch ?? null

  const openCount = allIssues.filter((i) => i.state === 'OPEN').length
  const closedCount = allIssues.filter((i) => i.state === 'CLOSED').length
  const openPRCount = allPRs.filter((p) => p.state === 'OPEN' && !p.isDraft).length
  const draftPRCount = allPRs.filter((p) => p.state === 'OPEN' && p.isDraft).length
  const mergedPRCount = allPRs.filter((p) => p.state === 'MERGED').length
  const closedPRCount = allPRs.filter((p) => p.state === 'CLOSED').length

  const filteredIssues = allIssues.filter((issue) => {
    if (currentIssueFilter === 'open' && issue.state !== 'OPEN') return false
    if (currentIssueFilter === 'closed' && issue.state !== 'CLOSED') return false
    return matches(issueQuery, issue.title, issue.number, issue.author, ...issue.labels.map((l) => l.name))
  })

  const filteredPRs = allPRs.filter((pr) => {
    if (currentPrFilter === 'open' && (pr.state !== 'OPEN' || pr.isDraft)) return false
    if (currentPrFilter === 'draft' && (pr.state !== 'OPEN' || !pr.isDraft)) return false
    if (currentPrFilter === 'merged' && pr.state !== 'MERGED') return false
    if (currentPrFilter === 'closed' && pr.state !== 'CLOSED') return false
    return matches(prQuery, pr.title, pr.number, pr.author, pr.headRefName)
  })

  const filteredBranches = allBranches.filter((branch) => matches(branchQuery, branch.name, branch.lastCommitSubject))

  const repoTitle = data?.repoSlug ?? (data?.workspacePath ? data.workspacePath.split('/').pop() : 'Repository')
  const candidates = data?.candidates ?? []
  const ambiguous = Boolean(data?.ambiguous) && candidates.length > 1

  const chooseCandidate = (path: string): void => {
    const choose = async (): Promise<void> => {
      try {
        set(lastResolvedPath, path)
        applyContext(await plugin.request('repo.chooseWorkspace', { path }), true)
      } catch {
        // keep the previous context if the worker cannot answer
      }
    }
    void choose()
  }

  const footer =
    currentTab === 'prs'
      ? { count: filteredPRs.length, noun: 'pull requests', path: 'pulls' }
      : currentTab === 'branches'
        ? { count: filteredBranches.length, noun: 'branches', path: 'branches' }
        : { count: filteredIssues.length, noun: 'issues', path: 'issues' }

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Text size="sm" weight="semibold" truncate>{repoTitle}</Text>
        <Row gap="xs" align="center">
          {data?.fetchedAt ? <RelativeTime at={data.fetchedAt} format="duration" muted /> : null}
          <IconButton
            icon="refresh"
            label="Refresh repository context"
            size="xs"
            onPress={() => void refresh(true)}
            disabled={isLoading}
          />
        </Row>
      </Row>

      {ambiguous ? (
        <Callout tone="warning" title="Which clone is this?" icon="warning">
          <Stack gap="sm">
            <Text size="xs">
              {`Several workspaces are on ${currentBranch ?? 'this branch'}. Pick one; it's remembered.`}
            </Text>
            <RadioGroup
              label="Workspace"
              labelHidden
              value={data?.workspacePath ?? undefined}
              options={candidates.map((c) => ({ value: c.path, label: c.name, description: c.path }))}
              onChange={chooseCandidate}
            />
          </Stack>
        </Callout>
      ) : null}

      {data ? <CurrentBranchCard data={data} /> : null}

      <Tabs label="Views" value={currentTab} onChange={(t) => set(activeTab, t)}>
        <Tab value="issues" label={`Issues ${openCount}`}>
          <Stack gap="sm">
            <Toolbar
              search={issueText}
              searchLabel="Search issues"
              placeholder="Title, #, label"
              onSearch={(val) => set(issueSearch, val)}
              filterLabel="Issue state"
              filter={currentIssueFilter}
              filterOptions={[
                { value: 'open', label: `Open · ${openCount}` },
                { value: 'closed', label: `Closed · ${closedCount}` },
                { value: 'all', label: `All · ${allIssues.length}` }
              ]}
              onFilter={(val) => set(issueFilter, val)}
            />
            <ListBody
              loading={firstLoad}
              noun="issues"
              error={data?.issuesError}
              count={filteredIssues.length}
              query={issueText.trim()}
              emptyIcon="check"
              onClear={() => set(issueSearch, '')}
            >
              <List label="GitHub Issues">
                {filteredIssues.map((issue) => (
                  <LinkedRow key={String(issue.number)} icon={issueIcon(issue)} url={issue.url} label={issue.title}>
                    <Title text={issue.title} url={issue.url} />
                    <Row gap="sm" align="center" wrap>
                      <Meta
                        number={issue.number}
                        at={issue.updatedAtMs}
                        extra={issue.commentsCount ? `${issue.commentsCount} comment${issue.commentsCount === 1 ? '' : 's'}` : undefined}
                      />
                      {issue.state === 'CLOSED' && currentIssueFilter === 'all' ? <Badge tone="neutral">closed</Badge> : null}
                      <Labels labels={issue.labels ?? []} />
                    </Row>
                  </LinkedRow>
                ))}
              </List>
            </ListBody>
          </Stack>
        </Tab>

        <Tab value="prs" label={`PRs ${openPRCount + draftPRCount}`}>
          <Stack gap="sm">
            <Toolbar
              search={prText}
              searchLabel="Search pull requests"
              placeholder="Title, #, branch"
              onSearch={(val) => set(prSearch, val)}
              filterLabel="Pull request state"
              filter={currentPrFilter}
              filterOptions={[
                { value: 'open', label: `Open · ${openPRCount}` },
                { value: 'draft', label: `Draft · ${draftPRCount}` },
                { value: 'merged', label: `Merged · ${mergedPRCount}` },
                { value: 'closed', label: `Closed · ${closedPRCount}` },
                { value: 'all', label: `All · ${allPRs.length}` }
              ]}
              onFilter={(val) => set(prFilter, val)}
            />
            <ListBody
              loading={firstLoad}
              noun="pull requests"
              error={data?.prsError}
              count={filteredPRs.length}
              query={prText.trim()}
              emptyIcon="branch"
              onClear={() => set(prSearch, '')}
            >
              <List label="Pull Requests">
                {filteredPRs.map((pr) => (
                  <LinkedRow key={String(pr.number)} icon={prIcon(pr)} url={pr.url} label={pr.title}>
                    <Title text={pr.title} url={pr.url} />
                    <Row gap="sm" align="center" wrap>
                      <Meta number={pr.number} at={pr.updatedAtMs} />
                      {currentPrFilter === 'all' || currentPrFilter === 'open' ? (
                        pr.state !== 'OPEN' || pr.isDraft ? <Badge tone="neutral">{prStateLabel(pr).toLowerCase()}</Badge> : null
                      ) : null}
                      {pr.headRefName && pr.headRefName === currentBranch ? <Badge tone="accent">this branch</Badge> : null}
                      <Labels labels={pr.labels ?? []} />
                    </Row>
                    {pr.headRefName ? (
                      <Text size="xs" muted truncate>{`${pr.headRefName} → ${pr.baseRefName ?? 'main'}`}</Text>
                    ) : null}
                  </LinkedRow>
                ))}
              </List>
            </ListBody>
          </Stack>
        </Tab>

        <Tab value="branches" label={`Branches ${allBranches.length}`}>
          <Stack gap="sm">
            <Toolbar
              search={branchText}
              searchLabel="Search branches"
              placeholder="Branch or commit"
              onSearch={(val) => set(branchSearch, val)}
            />
            <ListBody
              loading={firstLoad}
              noun="branches"
              error={data?.branchesError}
              count={filteredBranches.length}
              query={branchText.trim()}
              emptyIcon="branch"
              onClear={() => set(branchSearch, '')}
            >
              <List label="Git Branches">
                {filteredBranches.map((branch) => {
                  const pr = pullRequestFor(allPRs, branch.name)
                  const url = branchUrl(data?.repoSlug, branch)
                  return (
                    <LinkedRow key={branch.name} icon="branch" current={branch.isHead} url={url} label={branch.name}>
                      <Title text={branch.name} url={url} />
                      <Row gap="sm" align="center" wrap>
                        {branch.lastCommitDate ? <Meta date={branch.lastCommitDate.split(' ')[0]} /> : null}
                        {pr ? <Badge tone={pr.state === 'OPEN' ? 'success' : 'neutral'}>{`#${pr.number}`}</Badge> : null}
                        {branch.upstream ? null : <Badge tone="warning">local only</Badge>}
                      </Row>
                      {branch.lastCommitSubject ? <Text size="xs" muted truncate>{branch.lastCommitSubject}</Text> : null}
                    </LinkedRow>
                  )
                })}
              </List>
            </ListBody>
          </Stack>
        </Tab>
      </Tabs>

      {data?.repoSlug ? (
        <Row justify="between" align="center">
          <Text size="xs" muted>{`${footer.count} ${footer.noun}`}</Text>
          <Button
            size="xs"
            variant="ghost"
            icon="open-external"
            onPress={() => openUrl(`https://github.com/${data.repoSlug}/${footer.path}`)}
          >
            Open on GitHub
          </Button>
        </Row>
      ) : null}
    </Stack>
  )
}
