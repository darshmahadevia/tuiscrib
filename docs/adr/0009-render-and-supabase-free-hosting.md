# Host the Source-First Portfolio Demo on Render Free and Supabase Free

One Bun/Hono service instance runs on Render Free and uses Supabase Free PostgreSQL through Supavisor. Connected clients send authenticated application heartbeats that prevent Render's idle sleep and keep their Terminal Sessions active, while the TUI exposes waking and reconnecting states with bounded backoff for Render and Supabase cold starts or pauses. The free-tier availability, restart, retention, and resource limits are accepted as portfolio constraints rather than production guarantees.
