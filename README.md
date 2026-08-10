# Tuiscrib

Tuiscrib is a keyboard-first collaborative Sticky Note editor. This repository contains the reusable issue #3 terminal shell plus the issue #2 walking skeleton: a Bun workspace with a shared Zod contract, a Hono Tuiscrib Service, Drizzle/PostgreSQL persistence, and a React-bound OpenTUI terminal client.

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

The terminal client opens the keyboard-only shell. Press `b` for Boards, `s` to sign in, `r` to register, `x` to sign out, `?` for help, or `q` to quit. In the Board list, `c` creates a Board, `j` redeems a Join Code, `f` filters Memberships by Board name, and `[/]` selects the Board for actions. Board actions let the Owner use `r` to rename or `t` to rotate the Join Code; a Member can use `l` to leave after confirmation, while the Owner cannot leave. A created or rotated Board receives a grouped Join Code displayed only in that action result; the Tuiscrib Service stores only its verification hash. A valid Terminal Session is restored from the protected platform config location on launch and expires after 30 days without authenticated activity. The shell requires an 80 by 24 terminal and supports Unicode plus a 256-color baseline, with truecolor used when detected.

## Verification

The full test command includes the deterministic terminal-shell and multi-client acceptance seams. It starts a fresh PostgreSQL container, applies Drizzle migrations from zero, mounts OpenTUI test renderers, drives keyboard input, captures rendered frames, and tears down every resource:

```bash
bun test
```

To run only the walking-skeleton acceptance test:

```bash
bun run test:acceptance
```

For environments with an existing disposable PostgreSQL database, set `TEST_DATABASE_URL`; otherwise the acceptance harness uses `postgres:16-alpine` through Docker automatically.
