# OpenSwarm on Rails

OpenSwarm is a Rails app for visual Git worktree management. It renders worktrees as a graph and lets you run common branch workflows (fetch, pull, rebase, commit, push, merge) from one place.

## Repository layout

- `openswarm/` - main Rails 8.1 app (Hotwire + Tailwind + ActionCable)
- `desktop/` - Electron shell for packaging the app as a desktop client (macOS DMG support)
- `ui_scaffold/` - early static UI prototype

## Prerequisites

- Ruby `3.3.10`
- Bundler
- Node.js and npm
- Git

## Quick start

```bash
# from repo root
cd openswarm
bin/setup --skip-server
cd ..
make dev-backend
```

Then open `http://localhost:3000`.

If your target repository is not auto-detected, set `OPENSWARM_REPO_ROOTS`:

```bash
OPENSWARM_REPO_ROOTS="/absolute/path/to/repo" make dev-backend
```

## Common commands

- `make dev` - run Rails, Tailwind watcher, and the static scaffold server
- `make dev-backend` - run Rails and Tailwind watcher only
- `make dev-frontend` - serve `ui_scaffold/` only
- `make electron-dev` - run Rails and launch the Electron shell
- `make electron-dmg` - build a macOS `.dmg` in `desktop/dist/`
- `make electron-clean` - remove desktop build artifacts

## App-level commands

From `openswarm/`:

- `bin/rails test` - run test suite
- `bin/rubocop` - run lint checks
- `bin/brakeman` - run security scan
