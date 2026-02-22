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

Run from `openswarm/`:

```bash
bin/ci
```

`bin/ci` runs setup plus style and security checks used by this project.

## Troubleshooting

- Port already in use: stop any process on `3000` before running `make dev-backend`.
- Missing gems or npm packages: rerun `bin/setup --skip-server` inside `openswarm/`.
- Repo scan is too broad: set `OPENSWARM_REPO_ROOTS` to a small list of absolute paths (use `:` separator on macOS/Linux).
- Electron app does not launch: run `make electron-clean` and then `make electron-dev`.

## Contributing

Contributions are welcome. Keep changes focused, run `bin/ci` in `openswarm/`, and include clear commit messages that explain why the change is needed.
