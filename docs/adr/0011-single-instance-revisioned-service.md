# Use a lean revisioned collaboration service

One Bun/Hono service stores normalized current state in hosted PostgreSQL through Drizzle, while its single process owns in-memory Presence and Edit Claims. HTTPS handles authentication and Board administration, WebSockets handle active Board collaboration, and a shared workspace package supplies Zod-validated contracts; durable member-visible mutations serialize under one monotonic Board revision. Reconnecting clients load a fresh current snapshot before resuming revisioned events.
