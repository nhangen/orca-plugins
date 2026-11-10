# Git Issues & Branches

An Orca sidebar plugin that displays GitHub issues and git branches for the currently active repository.

## Features

- **GitHub Issues Tab**:
  - Automatically detects the GitHub repository slug (`owner/repo`) from the active workspace remote.
  - Queries GitHub issues via `gh` CLI (using existing authentication) or public GitHub REST API fallback.
  - Filters by issue state (`Open`, `Closed`, `All`) and real-time text search (by title, `#number`, or author).
  - Shows labels, state badges, author, and relative updated time.
  - Clicking any issue opens its web page in the default browser.
- **Git Branches Tab**:
  - Shows all local branches, with the currently checked-out branch marked with an active `HEAD` badge.
  - Shows upstream tracking branches and latest commit subjects with commit dates.
  - Real-time text search filter for quick branch lookups.
- **Auto-Syncing**:
  - Automatically updates when switching workspaces or worktrees in Orca (`workspace.changed` event).
  - Manual refresh button in the header.

## Architecture

This plugin uses the `worker-panel` pattern with two cooperating layers:

1. **Declarative TSX Panel (`src/panel.tsx`)**:
   - Runs in Orca's sandboxed components runtime (`"ui": "components"`).
   - Renders using Orca's native components (`Stack`, `Row`, `Heading`, `Tabs`, `Tab`, `List`, `ListItem`, `Badge`, `Button`, `IconButton`, `Input`, `Box`, `RelativeTime`).
   - Requests data from the worker via typed RPC (`repo.getContext`).
2. **Node.js Worker (`src/worker.ts`)**:
   - Runs as an out-of-process Node process on the host (`trusted-worker`).
   - Uses `workspace:read` capability to resolve active workspace details (`workspace.readContext` and `workspace.list`).
   - Executes local Git and GitHub CLI commands to collect branches and issues.
   - Caches state in `storage:own`.
3. **Type Protocol (`src/protocol.ts`)**:
   - Shared TypeScript contract declaring requests and events for compile-time safety.

## Testing & Validation

```sh
# Validate manifest and permissions
orca plugin validate .

# Run panel and worker test suite
orca plugin test .

# Render dry-run component check
orca plugin check .
```

## Running in Orca

To load this plugin into your local Orca instance:

```sh
orca plugin dev load ./plugins/git-issues
```

Or watch with live reloading:

```sh
orca plugin dev watch ./plugins/git-issues
```
