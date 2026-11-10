# orca-plugins

Collection of custom plugins for the [Orca](https://github.com/stablyai/orca) extensible editor environment.

## Included Plugins

| Plugin | Type | Description |
| :--- | :--- | :--- |
| [`plugins/git-issues`](plugins/git-issues) | `trusted-worker` | Sidebar panel showing GitHub issues, pull requests, and git branches for the active workspace. |

## Plugins Overview

### `git-issues`

Displays real-time GitHub issues, pull requests, and local Git branches in Orca's right sidebar for whichever workspace is currently active.

- **GitHub Issues**: Auto-detects the active repository's origin remote, queries issues via `gh` CLI or GitHub REST API, provides filters (Open/Closed/All) and search, and opens issue links directly in the browser.
- **Pull Requests**: Dedicated tab for PRs with Open, Draft, Merged, Closed, and All filters, showing branch targets and review status.
- **Git Branches**: Lists all local branches, shows active `HEAD`, upstream tracking branches, and recent commits.
- **Auto-Syncing**: Listens for Orca's `workspace.changed` events to refresh automatically when switching workspaces.

## Installation

In Orca:
1. Open **Settings → Plugins → ⋯ → Catalog sources**.
2. Add `https://github.com/nhangen/orca-plugins.git` with ref `main`.
3. Install **Git Issues, PRs & Branches** from the catalog list.

Alternatively, install directly via CLI:
```sh
orca plugin install https://github.com/nhangen/orca-plugins.git#main --path plugins/git-issues
```

## Developing Plugins

### Prerequisites

- Orca `1.4.248` or newer (`orca` CLI on PATH)
- Node.js 18+

### Testing & Validation

Run checks against any plugin folder:

```sh
# Validate manifest and capabilities
orca plugin validate ./plugins/git-issues

# Run the unit test suite
orca plugin test ./plugins/git-issues

# Run dry-run component check
orca plugin check ./plugins/git-issues
```

### Loading in Orca (Development Mode)

Load a plugin directly into your local Orca instance:

```sh
orca plugin dev load ./plugins/git-issues
```

Or watch files with live reloading:

```sh
orca plugin dev watch ./plugins/git-issues
```
