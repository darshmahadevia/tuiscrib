# Hosted two-user collaboration slice

Issue #16 packages one repository-owned Render Blueprint and Docker image for the first hosted Tuiscrib Service slice:

```text
Render Free web service (one Bun/Hono instance, HTTPS/WSS)
             │ pooled TLS PostgreSQL connection for runtime traffic
             ▼
Supabase PostgreSQL via Supavisor
             ▲ direct TLS or session-pooled TLS connection for migrations
```

The service remains the single hosted authority described by [ADR 0011](adr/0011-single-instance-revisioned-service.md). Presence and Edit Claims are process-local; current Board state, Membership, and Sticky Note state are durable in PostgreSQL. Supabase PostgreSQL with Supavisor is the selected implementation of the provider-neutral hosted pooled PostgreSQL requirement. This is a free-tier portfolio deployment, not a production-reliability claim.

## Repository-owned deployment contract

- [`render.yaml`](../render.yaml) declares one `free` Docker web service and `/health` as its health check. Render Free does not support a separate pre-deploy command, so migrations run in the service process before it binds its public port.
- [`Dockerfile`](../Dockerfile) runs the pinned Bun 1.3.14 image and starts `bun run service:start`.
- Render supplies `PORT`; the service binds `HOST=0.0.0.0` and configures Bun WebSockets with a bounded payload and idle timeout.
- The Render service process uses `MIGRATION_DATABASE_URL`, acquires the database migration advisory lock, replays current Drizzle migrations safely, verifies the readiness marker, then creates the runtime pool and binds the public port. `TUISCRIB_MIGRATIONS_PREDEPLOYED=false` keeps this startup migration path enabled.
- A local process that does not set `TUISCRIB_MIGRATIONS_PREDEPLOYED` performs the same locked migration before listening. Concurrent migration attempts wait for the same PostgreSQL advisory lock and fail clearly on timeout.
- The runtime pool defaults to four connections and accepts only two through eight through validated service configuration. Connect, idle, migration-lock, request-body, and WebSocket limits are bounded.
- Environment validation reports variable names and remediation without echoing connection URLs, passwords, Join Codes, or Terminal Session credentials. Startup, request, and smoke errors are redacted before logging.

Render terminates HTTPS and supports WebSocket connections for web services. The service therefore uses `https://` and `wss://` publicly while the container listens on HTTP internally. See the current [Render web service](https://render.com/docs/web-services), [Render Blueprint](https://render.com/docs/blueprint-spec), and [Bun WebSocket](https://bun.sh/docs/runtime/http/websockets) documentation when provider behavior changes.

## Required hosted configuration

Create or select the external resources in their provider dashboards, then set the following values in the Render service. The two database URLs may share a provider host but are deliberately separate connection roles.

| Variable | Hosted value | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Supabase Supavisor pooled TLS URL; the hostname identifies a pooler and the query contains `sslmode=require`. Runtime may use transaction mode on port `6543` or session mode on port `5432`. | Bounded pooled runtime PostgreSQL access |
| `MIGRATION_DATABASE_URL` | Prefer the Supabase direct TLS database URL. If direct access is unavailable, use Supavisor session mode on port `5432`. The query contains `sslmode=require`; never use transaction mode on port `6543`. | Advisory-locked Drizzle migrations |
| `NODE_ENV` | `production` | Enables hosted validation |
| `TUISCRIB_REQUIRE_POOLED_DATABASE_URL` | `true` | Rejects a runtime URL that does not identify a pooler |
| `TUISCRIB_MIGRATIONS_PREDEPLOYED` | `false` | Runs the locked migration in the service process before traffic; set `true` only when an external migration job has completed |
| `DATABASE_POOL_MAX` | `4` (bounded 2–8) | Keeps the Free-tier connection budget bounded |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `10` | Fails connection attempts clearly |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | `20` | Releases idle runtime connections |
| `MIGRATION_LOCK_TIMEOUT_MS` | `30000` | Bounds concurrent migration waiting |
| `WEBSOCKET_IDLE_TIMEOUT_SECONDS` | `120` | Bounds the Bun WebSocket idle window |

Supabase documents Supavisor session mode on port `5432` and transaction mode on port `6543`. Session mode reserves one underlying database connection for a client session, which preserves session-level advisory locks; transaction mode must not be used for migrations. See [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres) and [Supavisor connection terminology](https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO). The service uses direct PostgreSQL connections and does not depend on Supabase Auth, the Data API, or exposed public tables.

Supabase's current changelog includes a change making new public tables opt-in for Data API exposure. That does not change this service because Drizzle and `postgres-js` connect over PostgreSQL directly. See the [Supabase breaking-change changelog](https://supabase.com/changelog?types=breaking-change) before changing the database access path.

## Provisioning and linking

The official CLI can create a project without adding itself to this repository:

```bash
npx --yes supabase@2.113.0 projects create tuiscrib --org-id <org-id> --db-password '<one-time-password>' --region us-east-1 --size micro
```

Do not paste the password or resulting URLs into the repository, issue comments, or smoke output. Link only after the project exists and use the CLI's current `supabase link` help for the project reference. A paid upgrade, CAPTCHA, account-wide permission request, or destructive reuse of an unrelated project is a blocker for this ticket.

## Local and container verification

The full test suite starts a disposable PostgreSQL container, applies migrations from zero, drives the OpenTUI terminal shell, and exercises two live terminal clients. Run:

```bash
bun install --frozen-lockfile
bun test
```

The deterministic image smoke builds the repository Dockerfile, starts PostgreSQL and the Tuiscrib Service on an isolated Docker network, waits for the health check after startup migration, and runs the same network smoke used for a hosted URL:

```bash
bun run smoke:container
```

The hosted smoke creates two throwaway Users, creates a Board, redeems the Join Code, opens two authenticated WebSockets, publishes a durable Sticky Note, observes it from the second client, reconnects that client, and requires the authoritative snapshot to contain the note. It prints only a pass/fail summary:

```bash
TUISCRIB_SMOKE_REQUIRE_HTTPS=true \
  bun run smoke:hosted -- --url https://your-render-service.onrender.com
```

The smoke leaves generated Users and the Board in the configured database so that the public behavior being tested is real. Use a disposable Supabase project or other explicitly isolated database for repeated checks. The local OpenTUI rendering and keyboard behavior remains covered by the acceptance suite; the hosted smoke uses the same exported terminal network client over public HTTP/WebSocket boundaries.

## Free-tier constraints

Render Free services may sleep after inbound inactivity, restart without notice, run as a single instance, and have no persistent disk. A cold start can therefore make the first health check, HTTP request, or WebSocket connection slow or unavailable; the terminal client uses bounded reconnect behavior and authenticated heartbeats while connected. Render documents these limits in its [Free instance documentation](https://render.com/docs/free).

Supabase Free projects may be paused after low database activity, and the Free plan's compute, storage, egress, and connection limits may change. The current [Supabase project-pausing documentation](https://supabase.com/docs/guides/platform/free-project-pausing) describes the pause behavior. No uptime, durability-through-provider-outage, horizontal scaling, or production support guarantee is implied by this slice. A Render service URL is evidence of a deployed demo only when the hosted smoke passes against the public URL.
