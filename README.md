# OpenSwarm on Rails

OpenSwarm is a Rails app for visual Git worktree management. It shows worktrees as a graph and lets you create/delete worktrees, open terminals, and run common branch workflows (fetch/pull, rebase, commit, push, merge) from one UI.

## Repo layout

- `openswarm/` - main Rails 8.1 app (Hotwire + Tailwind + ActionCable)
- `desktop/` - Electron shell for running the Rails UI as a desktop app (macOS DMG support)
- `ui_scaffold/` - static early UI prototype

## Quick start

Prereqs: Ruby `3.3.10`, Bundler, Node.js/npm, Git.

```bash
# from repo root
make dev-backend
```

Then open `http://localhost:3000`.

If your target repo is not auto-detected:

```bash
OPENSWARM_REPO_ROOTS="/absolute/path/to/repo" make dev-backend
```

## Useful commands

- `make dev` - Rails app + Tailwind watcher + static scaffold server
- `make dev-frontend` - serve `ui_scaffold/` only
- `make electron-dev` - run Rails + desktop shell
- `make electron-dmg` - build desktop `.dmg` into `desktop/dist/`
- `make electron-clean` - remove desktop build artifacts
