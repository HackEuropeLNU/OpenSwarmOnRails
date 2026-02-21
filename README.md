# OpenSwarm on Rails

OpenSwarm is a Rails app for visual Git worktree management. It helps you see branch relationships as a graph and run common branch operations from one place.

## What it does

- Discovers repositories and their worktrees
- Visualizes branch/worktree relationships as a graph
- Creates and deletes worktrees
- Runs common workflows: fetch/pull, rebase, commit, push, merge
- Opens terminals in selected worktrees

## Repo layout

- `openswarm/` - main Rails 8.1 app (Hotwire + Tailwind)
- `desktop/` - Electron wrapper for running OpenSwarm as a desktop app
- `ui_scaffold/` - early static prototype

## Requirements

- Ruby `3.3.10` (see `openswarm/.ruby-version`)
- Bundler
- Node.js + npm
- Git

## Quick start

From the repo root:

```bash
cd openswarm
bin/setup --skip-server
cd ..
make dev-backend
```

Then open `http://localhost:3000`.

## Choose which repos to scan

OpenSwarm auto-discovers common local repos. To target specific repos, set `OPENSWARM_REPO_ROOTS`:

```bash
OPENSWARM_REPO_ROOTS="/absolute/path/to/repo:/another/repo" make dev-backend
```

Use your platform path separator in that variable (`:` on macOS/Linux).

## Common commands

- `make dev-backend` - Rails server + Tailwind watcher
- `make dev` - backend plus static `ui_scaffold/` server
- `make dev-frontend` - serve `ui_scaffold/` only
- `make electron-dev` - run backend and launch Electron shell
- `make electron-dmg` - build macOS `.dmg` into `desktop/dist/`
- `make electron-clean` - remove desktop build artifacts

## Quality checks

From `openswarm/`:

```bash
bin/ci
```

This runs setup plus style/security checks used by the project.
