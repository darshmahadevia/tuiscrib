# Build a keyboard-only Bun and OpenTUI React client

The terminal client uses React-bound OpenTUI in a Bun workspace monorepo and can be built locally for macOS, Linux, and Windows Unicode 256-color terminals when a developer needs standalone packaging verification, enhancing truecolor when detected. Its explicit Navigate and Edit modes are keyboard-only, and one opaque session token persists in the protected platform config directory.

The Navigate and Edit mode model is superseded by ADR-0014. The runtime, rendering, keyboard-only, packaging, color, and credential decisions remain accepted.
