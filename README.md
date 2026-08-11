# Tuiscrib

Tuiscrib is a keyboard-first collaborative Sticky Note editor for small groups. Open two terminal clients, join the same Board, and edit or arrange notes together while the Tuiscrib Service persists the shared state.

![Tuiscrib terminal collaboration canvas](docs/assets/tuiscrib-portfolio-screenshot.svg)

## Try it in one minute

1. Download the binary for your platform from the [GitHub Releases page](https://github.com/darshmahadevia/tuiscrib/releases).
2. On macOS or Linux, make the downloaded binary executable and start it. For Apple Silicon, for example:

   ```bash
   chmod +x ./tuiscrib-darwin-arm64
   ./tuiscrib-darwin-arm64
   ```

   Use `tuiscrib-darwin-x64`, `tuiscrib-linux-arm64`, or `tuiscrib-linux-x64` when that is your platform.

   On Windows, run `tuiscrib-windows-x64.exe` from PowerShell.
3. Press `r` to register a User, then enter a username and password twice.
4. Press `b`, then `c` to create a Board. Press `n`, type a Sticky Note, and press Escape to publish it.
5. Start a second client, press `b`, then `j`, and enter the displayed Join Code to collaborate.

The binaries include their runtime; Bun, Node.js, a package install, and this repository are not required. Tuiscrib needs an 80 by 24 terminal with Unicode and 256-color support.

## Choose the Tuiscrib Service

A standalone binary connects to `https://tuiscrib.onrender.com` by default. You can point it at another HTTP(S) server origin with either form:

```bash
./tuiscrib-linux-x64 --server https://your-service.example
TUISCRIB_URL=https://your-service.example ./tuiscrib-linux-x64
```

The precedence is `--server <url>` flag, then `TUISCRIB_URL`, then the hosted default. The URL must be an `http://` or `https://` origin with no credentials, path, query string, or fragment. Invalid values stop the client with a validation error. `TUISCRIB_URL` remains useful for local development, for example `http://127.0.0.1:3000`.

## Before you use it

This is the v0.1.0 Public Portfolio Release of a student passion project. Use non-sensitive data only.

- Identity is a username and password. Tuiscrib does not collect email, offer password recovery, delete identities, or export data. Losing both the password and the protected local Terminal Session credential can permanently lose access.
- The free Render and Supabase hosting may sleep, pause, restart, or lose data. There is no uptime, backup, recovery, or support guarantee.
- Release binaries are unsigned. Verify the SHA-256 checksum published beside each binary when the maintainer publishes v0.1.0.
- GitHub Issues is the reporting channel. There is no response-time promise or support commitment.

This release does not include installers, package-manager distribution, automatic updates, application-managed backups, monitoring, or an ongoing release cadence.

## Build and contribute

For local development, install Bun 1.3.14 and Docker Desktop, then start a disposable PostgreSQL instance:

```bash
docker run --name tuiscrib-postgres \
  --publish 127.0.0.1:5432:5432 \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=tuiscrib \
  --detach postgres:16-alpine
cp .env.example .env
bun install --frozen-lockfile
bun run db:migrate
bun run dev:service
```

In another terminal, run `bun run dev:terminal`. The full deterministic acceptance suite is `bun test`; typecheck all workspace packages with `bun run typecheck`.

Standalone build, checksum, smoke-test, and manual GitHub Release instructions are in [docs/release.md](docs/release.md). The two-client journey and hosted free-tier notes are in [docs/portfolio-demo.md](docs/portfolio-demo.md). Deployment details are in [docs/deployment.md](docs/deployment.md).

## License

Tuiscrib is released under the [MIT License](LICENSE).
