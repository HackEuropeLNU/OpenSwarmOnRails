Openswarm on Rails

## UI scaffold prototype

This repo now includes a first-pass GUI scaffold so we can iterate on look-and-feel before full Rails implementation.

- Prototype path: `ui_scaffold/index.html`
- Stack: Vue 3 (CDN) + Tailwind CSS (CDN)
- Includes: graph canvas, branch nodes, details panel, actions panel, keyboard-first interactions

### Run locally

From this repository root, run:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173/ui_scaffold/`.

### Keyboard hints

- `j` / `k`: move selected worktree node
- `Ctrl/Cmd + B`: cycle background mode (stars, grid, flat)
- `t`: toggle dark/light theme
