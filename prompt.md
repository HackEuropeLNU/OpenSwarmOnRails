# OpenSwarm on Rails - Build Prompt

## Context
- We are **not porting** the Rust TUI codebase (/Users/matar/fafo/OpenSwarm) do use as refernce thought.
- We are building a **new Rails application from scratch** that delivers the same core workflows: worktree management, terminal sessions, and keyboard-first navigation.
- Primary workspace path: `/Users/matar/fafo/.OpenSwarmOnRails-workspaces/scaffold`.

## Product Direction
- Build a **local-first** Rails app that runs on the developer machine.
- The app must be able to access local filesystem paths and git repositories under approved roots.
- UX goal: clean web UI with real-time updates, preserving the speed and intent of the original TUI.

## Core Technical Approach
- Backend: Ruby on Rails with service objects and background workers for long-running tasks.
- Realtime: ActionCable for streaming updates.
- Terminal in browser: `xterm.js` frontend backed by Ruby `PTY` sessions.
- Git operations: use `Open3` + `git` CLI for reliable worktree support.

## Clarification on System Access
- Rails can read/write folders and launch terminal processes if it runs locally with user permissions.
- In this project, terminal and git operations should run through controlled backend services (not direct arbitrary shell from controllers).
- Restrict operations to allowlisted roots, starting with `/Users/matar/fafo/.OpenSwarmOnRails-workspaces/scaffold` and configured repo paths.

## Initial Scope (MVP)
1. Register one or more workspace/repo roots.
2. Discover and display git worktrees with status.
3. Launch and manage PTY-backed terminal sessions per worktree.
4. Stream terminal output live to the UI and forward keystrokes back to PTY.
5. Provide keyboard-first navigation and quick actions.

## Suggested Stack
- Rails 8
- PostgreSQL
- Redis + Sidekiq
- Hotwire (Turbo + Stimulus)
- Tailwind CSS + ViewComponent
- xterm.js

## Non-Goals for First Iteration
- No direct codebase translation from Rust modules.
- No premature multi-user distributed architecture.
- No unrestricted shell execution across arbitrary filesystem paths.

## Success Criteria
- From the app, a user can open a repo under approved paths, view worktrees, and run an interactive terminal session in-browser.
- Session output is real-time and responsive.
- The UI is clean, fast, and keyboard-friendly.
