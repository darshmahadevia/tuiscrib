# Portfolio demonstration

This is the reproducible release demonstration for the focused Tuiscrib MVP. It uses the same public HTTP and WebSocket clients as the terminal shell; it does not add a browser client, a hidden admin API, or a compatibility layer.

## Local deterministic acceptance seam

From a checkout with Bun 1.3.14, Docker Desktop, and the locked dependencies:

```bash
bun install --frozen-lockfile
bun run test:acceptance
```

The acceptance harness creates a uniquely named disposable PostgreSQL container when `TEST_DATABASE_URL` is unset, applies all Drizzle migrations from zero, mounts OpenTUI test renderers, drives keyboard input, and disposes renderers, WebSockets, the service, the database pool, and the container. The rendered two-client coverage includes:

- two Users registering and signing in, then joining one Board;
- a durable Sticky Note being created and edited through the Edit Claim;
- independent movement, decorative recoloring, and Stacking Order changes;
- explicit Sticky Note deletion and Board deletion; and
- reconnecting from authoritative snapshots while preserving durable state.

The focused tests are named in the acceptance sources so a reviewer can jump directly to the relevant public seam:

- [`packages/acceptance/src/sticky-note.test.tsx`](../packages/acceptance/src/sticky-note.test.tsx) covers creation, editing, recoloring, and Sticky Note deletion;
- [`packages/acceptance/src/collaboration.test.tsx`](../packages/acceptance/src/collaboration.test.tsx) covers movement, overlapping-note reordering, Presence, reconnect, and service restart; and
- [`packages/acceptance/src/boards.test.ts`](../packages/acceptance/src/boards.test.ts) covers registration-backed Membership, Join Codes, authorization, and Board deletion.

## Hosted portfolio smoke

Run the public smoke against the deployed Render URL after the Supabase project is ready:

```bash
TUISCRIB_SMOKE_REQUIRE_HTTPS=true \
TUISCRIB_SMOKE_TIMEOUT_MS=120000 \
bun run smoke:hosted -- --url https://tuiscrib.onrender.com
```

The command creates two throwaway Users, creates one Board, redeems the Join Code, opens two authenticated WSS clients, creates two overlapping Sticky Notes, edits one, moves it, recolors it, raises it in Stacking Order, reconnects the second client, verifies the complete durable snapshot, deletes the edited Sticky Note, and finally deletes the Board. It checks authorization loss, Board-list removal, deleted-Board WebSocket privacy, deleted Join Code privacy, and final readiness. It prints only pass/fail summaries and redacts operational errors.

The hosted smoke deletes its Board on success and in best-effort failure cleanup. Tuiscrib intentionally has no identity-closure workflow, so the two generated User rows remain as harmless test data; use the repo-scoped disposable Supabase project for repeated runs. Local acceptance runs reset all disposable rows.

## Free-tier release limits

This URL is a portfolio demo, not a production guarantee:

- Render Free can sleep after 15 minutes without inbound HTTP or WebSocket messages, may restart, has an ephemeral filesystem, and may exhaust its monthly free hours. An active client heartbeat keeps its connection active; it cannot wake a paused or idle service before the next request.
- Supabase Free can pause a low-activity project after seven days. The owner must resume it in Supabase Studio; Tuiscrib cannot resume an unavailable database. Supabase documents a one-year restore window, but this repository has no application-managed backup or recovery workflow.
- Terminal credentials are unrecoverable by design: losing both the password and the protected local Terminal Session credential permanently loses access. There is no email, password reset, identity closure, offline cache, or mutation queue.
- The service is one Render instance with process-local Presence and Edit Claims. No uptime, horizontal scaling, outage durability, backup, restore, signing, notarization, or production support guarantee is claimed.

See [`docs/deployment.md`](deployment.md), [`docs/release.md`](release.md), and the ADRs for the complete provider and release constraints.
