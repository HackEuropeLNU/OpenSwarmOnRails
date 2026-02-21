# OpenSwarm Rails App

This directory contains the Rails application that powers OpenSwarm.

For workspace-level commands and Electron packaging, see the repository root README: `../README.md`.

## Requirements

- Ruby `3.3.10`
- Bundler
- Node.js and npm

## Setup

```bash
bin/setup --skip-server
```

This installs gems, prepares the database, and clears stale logs/temp files.

## Run in development

From the repository root, prefer:

```bash
make dev-backend
```

Or from this directory:

```bash
bin/dev
```

## Useful commands

- `bin/rails test` - run tests
- `bin/rubocop` - run linting
- `bin/brakeman` - run security checks
- `bin/rails db:prepare` - create/migrate database
