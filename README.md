# OpenSwarm on Rails

OpenSwarm is a Rails app for visual Git worktree management. It shows branch relationships as a graph and lets you run common branch workflows from one place.

## Features

- Discover local repositories and worktrees
- Visualize branch/worktree relationships
- Create and delete worktrees
- Run common Git workflows: fetch, pull, rebase, commit, push, merge
- Open terminals in selected worktrees

## Project structure

- `openswarm/`: main Rails 8.1 app (Hotwire + Tailwind + ActionCable)
- `desktop/`: Electron shell for running OpenSwarm as a desktop app
- `ui_scaffold/`: early static UI prototype

## Requirements

- Ruby `3.3.10` (see `openswarm/.ruby-version`)
- Bundler
- Node.js and npm
- Git

## Quick start

Run from the repository root:

```bash
cd openswarm
bin/setup --skip-server
cd ..
make dev-backend
```

Then open `http://localhost:3000`.

For Rails-app-only notes, see `openswarm/README.md`.

## Limit repository discovery

OpenSwarm auto-discovers common local repos. To scan specific repos only, set `OPENSWARM_REPO_ROOTS`:

```bash
OPENSWARM_REPO_ROOTS="/absolute/path/to/repo:/another/repo" make dev-backend
```

Use your platform path separator in that variable (`:` on macOS/Linux).

## Common commands

- `make dev-backend`: run Rails server + Tailwind watcher
- `make dev`: run backend and static `ui_scaffold/` server
- `make dev-frontend`: serve `ui_scaffold/` only
- `make electron-dev`: run backend and launch Electron shell
- `make electron-dmg`: build macOS `.dmg` in `desktop/dist/`
- `make electron-clean`: remove desktop build artifacts

## Quality checks

Run from `openswarm/`:

```bash
bin/ci
```

`bin/ci` runs setup plus style and security checks used by this project.

## Troubleshooting

- Port already in use: stop any process on `3000` before running `make dev-backend`.
- Missing gems or npm packages: rerun `bin/setup --skip-server` inside `openswarm/`.
- Repo scan is too broad: set `OPENSWARM_REPO_ROOTS` to a small list of absolute paths.
- Electron app does not launch: run `make electron-clean` and then `make electron-dev`.

## Contributing

Contributions are welcome. Keep changes focused, run `bin/ci` in `openswarm/`, and include clear commit messages that explain why the change is needed.
