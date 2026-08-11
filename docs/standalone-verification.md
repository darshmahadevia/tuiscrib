# Developer-only standalone verification

The source checkout is Tuiscrib's only distribution path for now. This optional maintainer document covers local standalone packaging and first-render verification; it does not publish binaries, create GitHub Releases or tags, attach checksums, or define a user download workflow. Most source users can ignore it.

## Service URL configuration

A locally built executable connects to the hosted Tuiscrib Service at `https://tuiscrib.onrender.com` when no override is supplied. The same client accepts an explicit `--server <url>` flag or `TUISCRIB_URL` environment variable:

```bash
./dist/standalone/tuiscrib-linux-x64 --server https://your-service.example
TUISCRIB_URL=https://your-service.example ./dist/standalone/tuiscrib-linux-x64
```

The precedence is `--server <url>` flag, then `TUISCRIB_URL`, then the hosted default. The value must be an `http://` or `https://` server origin. Credentials, a path, query string, and fragment are rejected because the terminal client derives the HTTP and WebSocket endpoints from the origin. Invalid values stop the client before it opens the terminal renderer. `TUISCRIB_URL=http://127.0.0.1:3000` remains the local-service configuration.

## Local target matrix

| Platform | Architecture | Bun target | Local output | Startup smoke |
| --- | --- | --- | --- | --- |
| macOS | arm64 (Apple Silicon) | `bun-darwin-arm64` | `tuiscrib-darwin-arm64` | local host or matching runner |
| macOS | x64 (Intel) | `bun-darwin-x64` | `tuiscrib-darwin-x64` | local host or matching runner |
| Linux | arm64 | `bun-linux-arm64` | `tuiscrib-linux-arm64` | local host or matching runner |
| Linux | x64 | `bun-linux-x64-baseline` | `tuiscrib-linux-x64` | local host or matching runner |
| Windows | x64 | `bun-windows-x64` | `tuiscrib-windows-x64.exe` | local host or matching runner |

Linux x64 uses Bun's baseline target for older CPU compatibility. Linux builds select glibc. Windows arm64 is outside the defined matrix because Bun 1.3.14 standalone Windows arm64 cannot initialize OpenTUI's native FFI runtime in that build.

Every locally built executable is intended for a terminal of at least 80 by 24 cells, Unicode text, keyboard-only input, and an ANSI 256-color baseline. OpenTUI may use truecolor when the terminal advertises it; truecolor is an enhancement rather than a requirement.

## Protected Terminal Session location

The raw opaque Terminal Session credential is stored only in the platform-conventional application config location and is protected for the current OS user:

| Platform | Credential path | Protection |
| --- | --- | --- |
| macOS | `$HOME/Library/Application Support/Tuiscrib/session` | owner-only directory/file permissions |
| Linux | `$XDG_CONFIG_HOME/tuiscrib/session`, or `~/.config/tuiscrib/session` | directory mode `0700`, file mode `0600`, current-user ownership |
| Windows | `%APPDATA%\Tuiscrib\session` | current-user application-data ACLs; symlinks are rejected |

The credential is written atomically, never logged, and removed on sign-out. The service stores only its hash.

## Local standalone build

Builds use the Bun version pinned by `package.json` (`1.3.14`) and the checked-in `bun.lock`. OpenTUI's optional native packages for every target must be present before compiling:

```bash
bun install --frozen-lockfile --os="*" --cpu="*"
```

Build all defined local targets into a directory:

```bash
bun run build:standalone -- --all --output dist/standalone
```

Build the host target and verify two same-target builds are byte-identical:

```bash
bun run build:standalone -- --verify-reproducible
```

The build disables `.env` and `bunfig.toml` autoloading so local development configuration cannot enter an executable. Linux builds define `OPENTUI_LIBC=glibc` at build time, allowing Bun/OpenTUI to embed only the selected native branch.

## First-render smoke test

The smoke test launches a locally built executable with an isolated config home, `TERM=xterm-256color`, and a `PATH` containing no development tools. It captures the first rendered output from a controlled terminal stream, waits for the keyboard-only shell markers, sends `q`, and requires a clean exit plus the shell's `256-color baseline active` capability marker. POSIX streams additionally require indexed ANSI 256-color output. On Windows, the runner uses the locked `node-pty` ConPTY binding so OpenTUI sees a pseudo-console rather than a plain pipe.

```bash
bun run smoke:standalone -- --binary dist/standalone/tuiscrib-darwin-arm64
```

The test is intentionally limited to packaging and the first render. Full collaboration behavior remains covered by the source acceptance seam and the hosted smoke described in [docs/portfolio-demo.md](portfolio-demo.md).
