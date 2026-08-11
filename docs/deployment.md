# Hosted two-user collaboration slice

Issue #16 packages one repository-owned Render Blueprint and Docker image for the first hosted Tuiscrib Service slice:

```text
Render Free web service (one Bun/Hono instance, HTTPS/WSS)
             │ pooled TLS PostgreSQL connection for runtime traffic
             ▼
        Neon PostgreSQL
             ▲ direct TLS connection for migrations only
```

The service remains the single hosted authority described by [ADR 0011](adr/0011-single-instance-revisioned-service.md). Presence and Edit Claims are process-local; current Board state, Membership, and Sticky Note state are durable in PostgreSQL. This is a free-tier portfolio deployment, not a production-reliability claim.

## Repository-owned deployment contract

- [`render.yaml`](../render.yaml) declares one `free` Docker web service, `/health` as its health check, and `bun run service:migrate` as its pre-deploy command.
- [`Dockerfile`](../Dockerfile) runs the pinned Bun 1.3.14 image and starts `bun run service:start`.
- Render supplies `PORT`; the service binds `HOST=0.0.0.0` and configures Bun WebSockets with a bounded payload and idle timeout.
- The Render pre-deploy step uses the direct migration URL, acquires the database migration advisory lock, replays current Drizzle migrations safely, and verifies the readiness marker. The serving process uses the pooled runtime URL, sets `TUISCRIB_MIGRATIONS_PREDEPLOYED=true`, checks readiness again, and only then listens for traffic.
- A local process that does not set `TUISCRIB_MIGRATIONS_PREDEPLOYED` performs the same locked migration through the direct migration URL before listening. Concurrent migration attempts wait for the same PostgreSQL advisory lock and fail clearly on timeout.
- The runtime pool defaults to four connections and accepts only two through eight through validated service configuration. Connect, idle, migration-lock, request-body, and WebSocket limits are bounded.
- Environment validation reports variable names and remediation without echoing connection URLs, passwords, Join Codes, or Terminal Session credentials. Startup and request errors are redacted before logging.

Render terminates HTTPS and supports WebSocket connections for web services. The service therefore uses `https://` and `wss://` publicly while the container listens on HTTP internally. See the current [Render web service](https://render.com/docs/web-services), [Render Blueprint](https://render.com/docs/blueprint-spec), and [Bun WebSocket](https://bun.sh/docs/runtime/http/websockets) documentation when provider behavior changes.

## Required hosted configuration

Create or select the external resources in their provider dashboards, then set only the following secret in the Render service:

| Variable | Hosted value | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Neon pooled TLS URL; host contains `-pooler` and query contains `sslmode=require` | Pooled runtime PostgreSQL access |
| `MIGRATION_DATABASE_URL` | Neon direct TLS URL; host must not contain `-pooler` and query contains `sslmode=require` | Advisory-locked Drizzle migrations |
| `NODE_ENV` | `production` | Enables hosted validation |
| `TUISCRIB_REQUIRE_POOLED_DATABASE_URL` | `true` | Rejects an unpooled Neon endpoint |
| `TUISCRIB_MIGRATIONS_PREDEPLOYED` | `true` | Requires Render's pre-deploy migration to finish first |
| `DATABASE_POOL_MAX` | `4` (bounded 2–8) | Keeps the Free-tier connection budget bounded |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `10` | Fails connection attempts clearly |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | `20` | Releases idle runtime connections |
| `MIGRATION_LOCK_TIMEOUT_MS` | `30000` | Bounds concurrent migration waiting |
| `WEBSOCKET_IDLE_TIMEOUT_SECONDS` | `120` | Matches the Bun/Render Free-tier activity window |

Neon exposes a pooled connection URI through its connection details/API; the pooled hostname is the `-pooler` endpoint. Neon documents that its pooler uses PgBouncer transaction mode, where session-level advisory locks and ORM migration tools are unsupported, so migrations deliberately use the direct endpoint. See [Neon connection URI](https://api-docs.neon.tech/reference/getconnectionuri) and [Neon connection pooling](https://neon.com/docs/connect/connection-pooling). Do not commit either URI or paste them into issue comments or smoke output.

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

The smoke leaves generated Users and the Board in the configured database so that the public behavior being tested is real. Use a disposable Neon branch or other explicitly isolated database for repeated checks. The local OpenTUI rendering and keyboard behavior remains covered by the acceptance suite; the hosted smoke uses the same exported terminal network client over public HTTP/WebSocket boundaries.

## Free-tier constraints

Render Free services may sleep after inbound inactivity, restart without notice, run as a single instance, and have no persistent disk. A cold start can therefore make the first health check, HTTP request, or WebSocket connection slow or unavailable; the terminal client uses bounded reconnect behavior and authenticated heartbeats while connected. Render documents these limits in its [Free instance documentation](https://render.com/docs/free).

Neon Free plan quotas, compute suspension, retention, and connection limits are provider-plan constraints and may change. Use the pooled endpoint and the bounded runtime pool above, and check the current [Neon documentation](https://neon.tech/docs) before provisioning. No uptime, durability-through-provider-outage, horizontal scaling, or production support guarantee is implied by this slice. A Render service URL is evidence of a deployed demo only when the hosted smoke passes against the public URL.
