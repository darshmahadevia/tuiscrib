# Host the portfolio release on Render Free and Neon Free

One Bun/Hono service instance runs on Render Free and uses Neon Free PostgreSQL. Connected clients send authenticated application heartbeats that prevent Render's idle sleep and keep their Terminal Sessions active, while the TUI exposes waking and reconnecting states with bounded backoff for Render and Neon cold starts. The free-tier availability, restart, retention, and resource limits are accepted as portfolio constraints rather than production guarantees.
