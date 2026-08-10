import { createPersistence } from "@tuiscrib/persistence"

import { createServiceApp } from "./app.ts"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to start the Tuiscrib Service")
}

const persistence = createPersistence({ databaseUrl })
await persistence.migrate()

const port = Number(process.env.PORT ?? 3000)
const server = Bun.serve({
  hostname: process.env.HOST ?? "0.0.0.0",
  port,
  fetch: createServiceApp({ persistence }).fetch,
})

console.log(`Tuiscrib Service listening on port ${server.port}`)

const shutdown = async () => {
  server.stop(true)
  await persistence.close()
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
