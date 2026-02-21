# OpenSwarm Rails App

This directory contains the main OpenSwarm Rails application.

For project-level setup and desktop workflow commands, start with `../README.md`.

## Requirements

- Ruby `3.3.10`
- Bundler
- Node.js and npm

## Local setup

```bash
bin/setup --skip-server
```

This installs gems, prepares the database, and clears stale logs/temp files.

## Run locally

From the repository root, prefer:

```bash
make dev-backend
```

Or from this directory:

```bash
bin/dev
```

## Checks

```bash
bin/ci
```

`bin/ci` runs setup plus style and security checks configured in `config/ci.rb`.
