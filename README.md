# Tuiscrib

Tuiscrib is a keyboard-first collaborative Sticky Note editor. This repository currently contains the issue #2 walking skeleton: a Bun workspace with a shared Zod contract, a Hono Tuiscrib Service, Drizzle/PostgreSQL persistence, and a React-bound OpenTUI terminal client.

## Prerequisites

- Bun 1.3.14
- Docker Desktop with the PostgreSQL image available

Create a disposable local PostgreSQL instance for development:

```bash
docker run --name tuiscrib-postgres \
  --publish 127.0.0.1:5432:5432 \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=tuiscrib \
  --detach postgres:16-alpine
```

Copy `.env.example` to `.env`, then run the migration and processes in separate terminals:

```bash
cp .env.example .env
bun install
bun run db:migrate
bun run dev:service
bun run dev:terminal
```

The terminal client renders the Zod-validated `/health?probe=readiness` response after the Hono process executes a real PostgreSQL readiness query. Press `r` to refresh or `q` to quit.

## Verification

The full test command includes the deterministic multi-client acceptance seam. It starts a fresh PostgreSQL container, applies Drizzle migrations from zero, mounts two OpenTUI test renderers, drives keyboard input, captures frames, and tears down every resource:

```bash
bun test
```

To run only the walking-skeleton acceptance test:

```bash
bun run test:acceptance
```

For environments with an existing disposable PostgreSQL database, set `TEST_DATABASE_URL`; otherwise the acceptance harness uses `postgres:16-alpine` through Docker automatically.
