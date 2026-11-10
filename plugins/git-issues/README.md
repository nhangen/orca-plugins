# Git Issues, PRs & Branches

![Cover](assets/cover.png)

An Orca sidebar plugin that displays GitHub issues, pull requests, and git branches for the currently active repository in Orca's right sidebar. Available on the [Orca Plugin Directory](https://www.onorca.dev/plugins/nhangen/orca-plugins).

## Overview

![Screenshot](assets/screenshot.png)

## Features

- **GitHub Issues Tab**:
  - Automatically detects the GitHub repository slug (`owner/repo`) from the active workspace remote.
  - Queries GitHub issues via `gh` CLI (using existing authentication) or public GitHub REST API fallback.
  - Filters by issue state (`Open`, `Closed`, `All`) and real-time text search (by title, `#number`, or author).
  - Shows labels, state badges, author, and relative updated time.
  - Clicking any issue opens its web page in your default browser.
- **Pull Requests Tab**:
  - Displays pull requests with dedicated status filters: `Open`, `Draft`, `Merged`, `Closed`, and `All`.
  - Distinguishes draft PRs with clear badges.
  - Displays head and target branches (`branch → main`), author, and relative updated timestamps.
  - Clicking any pull request opens it in your default browser.
- **Git Branches Tab**:
  - Shows all local branches, with the currently checked-out branch marked with an active `HEAD` badge.
  - Shows upstream tracking branches and latest commit subjects with commit dates.
  - Real-time text search filter for quick branch lookups.
- **Auto-Syncing**:
  - Automatically updates when switching workspaces or worktrees in Orca (`workspace.changed` event).
  - Includes a manual refresh button in the header.

## Requirements & Setup

- **Orca**: Version `>= 1.4.248`.
- **Git**: Local `git` binary on PATH.
- **GitHub Authentication** (Optional but recommended):
  - For **public repositories**: The plugin queries GitHub's public REST API automatically without configuration.
  - For **private repositories**: Install the GitHub CLI (`gh`) and run `gh auth login`, or set `GITHUB_TOKEN` in your environment. The plugin worker automatically inherits your local `gh` authentication credentials.

## Installation

### From the Orca Marketplace / Catalog

1. In Orca, open **Settings** (`Cmd+,` or `Ctrl+,`) > **Plugins**.
2. Search for **Git Issues, PRs & Branches** (`nhangen.git-issues`).
3. Click **Install** and approve the required capabilities (`workspace:read`, `storage:own`).

### Manual / Development CLI Load

```sh
# Clone this repository
git clone https://github.com/nhangen/orca-plugins.git
cd orca-plugins

# Load as a local development plugin
orca plugin dev load ./plugins/git-issues
```

Or run with live reload during development:
```sh
orca plugin dev watch ./plugins/git-issues
```

## FAQ & Troubleshooting

### Why are issues or PRs not showing for my private repo?
Ensure the GitHub CLI is authenticated on your machine by running `gh auth status` in your terminal. Once authenticated, click the refresh button in the plugin header.

### Does this work with SSH remotes?
Yes. The plugin parses standard HTTPS remotes (`https://github.com/owner/repo.git`), standard SSH remotes (`git@github.com:owner/repo.git`), and custom SSH config host aliases (e.g. `github-nhangen:owner/repo.git`).

### What permissions does this plugin need?
- `workspace:read`: Used to read the active workspace directory path and branch name to query git status.
- `storage:own`: Used to cache repository issues and pull requests locally to minimize network latency and API requests.

### Why does the panel show the wrong repo when several main clones are on `main`?
Orca's plugin API reports the focused workspace as `{branch, displayName}` only — no path or workspace id — and Orca names every root clone after its checked-out branch (`main`). When two or more local repositories sit on the same branch with the same name, the plugin cannot tell which one you focused, so the panel shows a **workspace picker at the top**. Choose your repo and the pick is remembered for that branch + name, across worker restarts.

The pick is shared by every workspace with that branch and name: after you pick `claude-ceo`, focusing another `main`/`main` clone still shows `claude-ceo` until you pick again. To make a clone resolve on its own, rename its workspace in Orca (`tab.rename` → `workspace.rename`); a unique name on the shared branch matches exactly and needs no picker.

### What if I rename a workspace later?
A renamed workspace with a unique name resolves directly. If the new name is shared too, the pick is keyed by the new branch + name, so pick again once.

### Does the panel see workspaces on remote hosts?
No. `workspace.list` spans every host Orca reaches, but the plugin only runs `git` and `gh` on this machine, so it ignores workspaces whose `hostId` names a remote host. Orca does not say which host the focused workspace is on, so focusing a remote workspace shows the local repo on the same branch.

## Architecture

This plugin uses the `worker-panel` pattern:

1. **Declarative TSX Panel (`src/panel.tsx`)**:
   - Runs in Orca's sandboxed components runtime (`"ui": "components"`).
   - Renders with Orca's native components (`Stack`, `Row`, `Tabs`, `Tab`, `List`, `ListItem`, `Badge`, `Button`, `IconButton`, `Input`, `Box`, `RelativeTime`).
   - Communicates with the background worker via typed RPC (`repo.getContext`).
2. **Node.js Worker (`src/worker.ts`)**:
   - Runs as an out-of-process process on the host (`trusted-worker`).
   - Uses `workspace:read` capability to resolve active workspace details (`workspace.readContext` and `workspace.list`).
   - Executes local Git and GitHub CLI commands to collect branches, issues, and PRs.
   - Caches state in `storage:own`.
3. **Type Protocol (`src/protocol.ts`)**:
   - Shared TypeScript contract declaring requests and events for type safety.

## Testing & Verification

```sh
# Validate manifest and permissions
orca plugin validate ./plugins/git-issues

# Run panel and worker test suite
orca plugin test ./plugins/git-issues

# Render dry-run component check
orca plugin check ./plugins/git-issues
```

## License

MIT © [nhangen](https://github.com/nhangen)
