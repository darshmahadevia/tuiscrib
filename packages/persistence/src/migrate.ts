import { createPersistence } from "./client.ts"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run migrations")
}

const persistence = createPersistence({ databaseUrl })
try {
  await persistence.migrate()
} finally {
  await persistence.close()
}
