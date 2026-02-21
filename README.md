Openswarm on Rails

## UI scaffold prototype

This repo now includes a first-pass GUI scaffold so we can iterate on look-and-feel before full Rails implementation.

- Prototype path: `ui_scaffold/index.html`
- Stack: Vue 3 (CDN) + Tailwind CSS (CDN)
- Includes: graph canvas, branch nodes, details panel, actions panel, keyboard-first interactions

### Run locally

Backend-first mode (recommended):

```bash
make dev-backend
```

Then open `http://localhost:3000/`.
This command now runs both the Rails server and the Tailwind watcher.

If your repo root is not auto-detected, set it explicitly:

```bash
OPENSWARM_REPO_ROOTS="/absolute/path/to/your/repo" make dev-backend
```

Use multiple roots by separating them with `:`.

If your Rails app directory is named differently, override it:

```bash
OPENSWARMONRAILS_DIR="openswarmonrails" make dev-backend
```

### Desktop app (Electron, macOS)

For local desktop testing on macOS, this repo includes an Electron shell in `desktop/`.

1) Start backend + desktop shell together:

```bash
make electron-dev
```

2) Build a `.dmg`:

```bash
make electron-dmg
```

Artifacts are written to `desktop/dist/`.

### Iterating on versions and cleanup

- Clear desktop build artifacts and Electron caches:

```bash
make electron-clean
```

- Bump `version` in `desktop/package.json` before release-style builds so each DMG has a distinct filename.
- Optional local app state reset between iterations:

```bash
rm -rf "$HOME/Library/Application Support/OpenSwarm"
```

Start backend + frontend together:

```bash
make dev
```

- Backend (Rails): `http://localhost:3000/`
- Frontend scaffold: `http://localhost:4173/ui_scaffold/`

You can also run each service separately:

```bash
make dev-backend
make dev-frontend
```

From this repository root, run:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173/ui_scaffold/`.

Note: the scaffold is static UI only. Creating worktrees and opening terminals are implemented in the Rails app at `http://localhost:3000/`.

### Keyboard hints

- `j` / `k`: move selected worktree node
- `Ctrl/Cmd + B`: cycle background mode (stars, grid, flat)
- `t`: toggle dark/light theme
