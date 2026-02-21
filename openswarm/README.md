# OpenSwarm Rails App

This directory contains the main OpenSwarm Rails application.

For project-level setup and desktop workflow commands, start with the root README:

- `../README.md`

## Local setup

```bash
bundle install
bin/setup --skip-server
```

## Run locally

```bash
bin/rails server
bin/rails tailwindcss:watch
```

Or from the repository root, use:

```bash
make dev-backend
```

## Checks

```bash
bin/ci
```

`bin/ci` runs setup plus style and security checks configured in `config/ci.rb`.
