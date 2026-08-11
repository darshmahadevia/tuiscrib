# Keep Tuiscrib as a Source-First Portfolio Demo

For now, Tuiscrib's source checkout is the distribution surface. A user should clone the repository, use Bun 1.3.14 with the frozen lockfile, and run the terminal client against the hosted Tuiscrib Service by default. Docker and PostgreSQL are optional for local service development, not prerequisites for trying the client. Tuiscrib will not publish a public binary GitHub Release or require users to obtain binary artifacts.

The hosted Tuiscrib Service on free Render and Supabase plans remains available as a best-effort demonstration. It may sleep, pause, restart, or lose data, with no availability, backup, recovery, or support guarantee. Users should use non-sensitive data only. GitHub Issues is the reporting channel, with no guaranteed response time or support commitment.

The existing username, password, and Terminal Session identity model remains unchanged: there is no email verification, password recovery, identity deletion, or data export. Open registration keeps the hosted demonstration easy to try without adding invitation administration.

## Considered Options

A public binary release would reduce setup for some evaluators but would add publication, artifact, signing, and support expectations that are not needed for the current portfolio demonstration. An invitation-only hosted beta would reduce operational exposure but would prevent evaluators from trying the project without coordination. The source-first path keeps one simple, inspectable workflow while preserving the hosted two-client demo.

## Consequences

The README must lead with clone, Bun 1.3.14, frozen install, and `bun run dev:terminal`, and must document the hosted default plus `--server` and `TUISCRIB_URL` overrides. Free-host and account limitations remain explicit. Standalone packaging and first-render smoke checks may remain as optional developer-only verification, but they do not create public artifacts, checksums, publication instructions, or a release cadence. The MIT license, hosted service, screenshot, and UI follow-up work remain in scope.
