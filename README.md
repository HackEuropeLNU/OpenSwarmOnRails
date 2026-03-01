# OpenSwarm on Rails

### A keyboard-first UI for running parallel AI agents across Git worktrees

OpenSwarm is a Rails app that helps you manage multiple AI agents and Git worktrees from one screen without juggling terminals, manual `git worktree` commands, or context switching.

## Demo video

https://youtu.be/RGQ21Z-W6Pw 

## The problem

Running 5-10 parallel agents today requires juggling:

- **Worktree lifecycle**: `git worktree add -b feat ../repo.feat`, then `cd`, then clean up later
- **Multiple terminals**: one per agent, arranged across tmux panes or OS windows
- **Status awareness**: which branch is dirty, ahead/behind, or actively running
- **Git operations**: staging, committing, pushing, and merging spread across sessions

This works for two agents. At five or more, it becomes unmanageable.

## How OpenSwarm on Rails solves it

OpenSwarm replaces the juggling with a single integrated UI:

- Visual worktree graph with live status
- Embedded terminals per worktree
- Inline staging and diffs
- One-key commits, pushes, and merges
- Launch agents (Claude, OpenCode, or a plain shell) on any node

Everything stays in one screen. No `cd`. No window switching. No lost context.

## Hackeurope build

OpenSwarm on Rails was built during the Hackeurope hackathon under the "Agentic AI Track". We chose these sub-challenges and implemented them as follows:

- **Best "Built on Rails" Project**: the entire product is a Rails app with a real-time, keyboard-first UI for managing worktrees, agents, and Git operations in one place.
- **Best Use of Zed**: we built a Zed-inspired workflow and environment inside the app (fast, keyboard-first, low-friction navigation), without relying on Zed itself.
- **Best Use of Miro AI**: we implemented PRD export to Miro for collaborative planning and editing, then re-imported those PRDs back into the app to drive worktree/agent execution.

## Quick start

From the repository root:

```bash
cd openswarm
bin/setup --skip-server
cd ..
make dev-backend
```

Open `http://localhost:3000`.

## Workflow highlights

- Press `a` to create a worktree from a base branch
- Press `O` to launch an agent, or `o` for a shell
- Press `c` to commit, `p` to push, `m` to merge into the parent
- Press `d` to delete a worktree, `x` to prune stale entries

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

