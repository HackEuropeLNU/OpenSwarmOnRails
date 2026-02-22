# OpenSwarm on Rails

OpenSwarm is a Rails app for visual Git worktree management.

## Quick start

From the repository root:

```bash
cd openswarm
bin/setup --skip-server
cd ..
make dev-backend
```

Open `http://localhost:3000`.

## Requirements

- Ruby `3.3.10`
- Bundler
- Node.js and npm
- Git

## Common commands

- `make dev-backend`: run Rails server + Tailwind watcher
- `make dev`: run backend + static `ui_scaffold/` server
- `make electron-dev`: run backend + Electron shell
- `make electron-dmg`: build macOS `.dmg` in `desktop/dist/`

## Notes

- Rails-app-only docs: `openswarm/README.md`
- Limit repo discovery with `OPENSWARM_REPO_ROOTS` (use `:` separator on macOS/Linux)
- Run checks from `openswarm/` with `bin/ci`
