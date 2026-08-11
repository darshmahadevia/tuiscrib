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

The terminal client opens the keyboard-only shell. Press `b` for Boards, `s` to sign in, `r` to register, `x` to sign out, `?` for help, or `q` to quit. In the Board list, `c` creates a Board, `j` redeems a Join Code, `f` filters Memberships by Board name, and `[/]` selects the Board for actions. Board actions let the Owner use `r` to rename or `t` to rotate the Join Code; a Member can use `l` to leave after confirmation, while the Owner cannot leave. In an open Board, arrows or `hjkl` move the canvas cursor, `n` starts a provisional Sticky Note, and Enter enters Edit mode; the first non-empty text snapshot is saved durably for every connected Member. A created or rotated Board receives a grouped Join Code displayed only in that action result; the Tuiscrib Service stores only its verification hash. A valid Terminal Session is restored from the protected platform config location on launch and expires after 30 days without authenticated activity. The shell requires an 80 by 24 terminal and supports Unicode plus a 256-color baseline, with truecolor used when detected.

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

Standalone release builds for macOS, Linux, and Windows are documented in [docs/release.md](docs/release.md). With Bun 1.3.14 and the locked dependencies installed for every target, build all five artifacts with:

```bash
bun install --frozen-lockfile --os="*" --cpu="*"
bun run build:release -- --all --output dist/releases
```

## Hosted deployment

The first hosted two-user collaboration slice is defined by [`render.yaml`](render.yaml), [`Dockerfile`](Dockerfile), and [docs/deployment.md](docs/deployment.md). It uses one Render Free Bun/Hono service with HTTPS/WebSockets and hosted pooled PostgreSQL. Supabase PostgreSQL with Supavisor is the selected implementation. The service process uses a separate direct Supabase URL, or Supavisor session mode on port 5432 when direct access is unavailable, to apply the current Drizzle migrations under a PostgreSQL advisory lock before it binds the public port; transaction pooling on port 6543 is never used for migrations.

Build and verify the local image plus a disposable PostgreSQL instance with:

```bash
bun run smoke:container
```

After a real Render service and Supabase project are provisioned, verify the public URL with:

```bash
TUISCRIB_SMOKE_REQUIRE_HTTPS=true \
  bun run smoke:hosted -- --url https://your-render-service.onrender.com
```

Render Free spins down after 15 minutes without inbound HTTP/WebSocket traffic and may restart or exhaust its free-hour quota; Supabase Free projects may pause after seven days of low activity and require owner resume. The client shows `WAKING` and retries with capped backoff, but the deployment cannot resume a paused project and makes no production-reliability claim. See [docs/deployment.md](docs/deployment.md) for the exact provider limits and deployment evidence required for issue #18.
