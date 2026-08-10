# Standalone terminal release

Tuiscrib ships one Bun standalone executable per supported platform architecture. The executable contains the Bun runtime, the React-bound OpenTUI client, and the OpenTUI native runtime assets; running a release binary does not require Bun, Node.js, a package install, or the repository.

## Support matrix

| Platform | Architecture | Bun target | Artifact | Linux libc | Startup smoke |
| --- | --- | --- | --- | --- | --- |
| macOS | arm64 (Apple Silicon) | `bun-darwin-arm64` | `tuiscrib-darwin-arm64` | — | native CI runner |
| macOS | x64 (Intel) | `bun-darwin-x64` | `tuiscrib-darwin-x64` | — | native CI runner |
| Linux | arm64 | `bun-linux-arm64` | `tuiscrib-linux-arm64` | glibc | native CI runner |
| Linux | x64 | `bun-linux-x64-baseline` | `tuiscrib-linux-x64` | glibc | native CI runner |
| Windows | x64 | `bun-windows-x64` | `tuiscrib-windows-x64.exe` | — | native CI runner |

Linux x64 uses Bun's baseline target for older CPU compatibility. Windows x64 uses Bun's standard target because the Windows baseline runtime cannot be reliably extracted by the hosted build runner. Linux release artifacts target glibc. OpenTUI also provides musl packages, but musl is not part of the published Tuiscrib matrix yet.

Windows arm64 is intentionally outside the supported release matrix: Bun 1.3.14 standalone Windows arm64 cannot initialize OpenTUI's native FFI runtime (`dlopen()` is unavailable in that build), so it cannot satisfy the startup smoke contract.

Every artifact supports a terminal of at least 80 by 24 cells, Unicode text, keyboard-only input, and an ANSI 256-color baseline. OpenTUI may use truecolor when the terminal advertises it; truecolor is an enhancement rather than a release requirement.

## Protected Terminal Session location

The raw opaque Terminal Session credential is stored only in the platform-conventional application config location and is protected for the current OS user:

| Platform | Credential path | Protection |
| --- | --- | --- |
| macOS | `$HOME/Library/Application Support/Tuiscrib/session` | owner-only directory/file permissions |
| Linux | `$XDG_CONFIG_HOME/tuiscrib/session`, or `~/.config/tuiscrib/session` | directory mode `0700`, file mode `0600`, current-user ownership |
| Windows | `%APPDATA%\Tuiscrib\session` | current-user application-data ACLs; symlinks are rejected |

The credential is written atomically, never logged, and removed on sign-out. The service stores only its hash.

## Reproducible build

Builds use the Bun version pinned by `package.json` (`1.3.14`) and the checked-in `bun.lock`. OpenTUI's optional native packages for every target must be present before compiling:

```bash
bun install --frozen-lockfile --os="*" --cpu="*"
```

Build all five artifacts into a directory:

```bash
bun run build:release -- --all --output dist/releases
```

Build the host artifact and verify two same-target builds are byte-identical:

```bash
bun run build:release -- --verify-reproducible
```

The build disables `.env` and `bunfig.toml` autoloading so local development configuration cannot enter a release executable. Linux builds define `OPENTUI_LIBC=glibc` at build time, allowing Bun/OpenTUI to embed only the selected native branch.

## Platform smoke test

The smoke test launches the compiled executable with an isolated config home, `TERM=xterm-256color`, and a `PATH` containing no development tools. It captures the first rendered output from a controlled terminal stream, waits for the keyboard-only shell markers, sends `q`, and requires a clean exit plus ANSI 256-color output:

```bash
bun run smoke:release -- --binary dist/releases/tuiscrib-darwin-arm64
```

The GitHub Actions matrix runs this build, reproducibility check, and smoke test on native macOS, Linux, and Windows runners for every architecture in the matrix. It does not require a service or database because the startup shell can render the signed-out state without network access.

Release executables are currently unsigned; platform signing credentials and distribution notarization are release-operator concerns, not runtime prerequisites.
