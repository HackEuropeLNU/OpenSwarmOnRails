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

If your repo root is not auto-detected, set it explicitly:

```bash
OPENSWARM_REPO_ROOTS="/absolute/path/to/your/repo" make dev-backend
```

Use multiple roots by separating them with `:`.

If your Rails app directory is named differently, override it:

```bash
OPENSWARMONRAILS_DIR="openswarmonrails" make dev-backend
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
