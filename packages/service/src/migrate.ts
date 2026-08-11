import { createPersistence } from "@tuiscrib/persistence"

import {
  loadServiceEnvironment,
  redactServiceError,
} from "./config.ts"

async function main(): Promise<void> {
  const configuration = loadServiceEnvironment()
  const persistence = createPersistence({
    databaseUrl: configuration.migrationDatabaseUrl,
    maxConnections: configuration.databasePoolMax,
    connectTimeoutSeconds: configuration.databaseConnectTimeoutSeconds,
    idleTimeoutSeconds: configuration.databaseIdleTimeoutSeconds,
    migrationLockTimeoutMs: configuration.migrationLockTimeoutMs,
    migrationLockPollMs: configuration.migrationLockPollMs,
  })

  try {
    await persistence.migrate()
    await persistence.healthCheck()
    console.log("Tuiscrib Service database migrations are ready")
  } finally {
    await persistence.close()
  }
}

try {
  await main()
} catch (error) {
  console.error(`Tuiscrib Service migration failed: ${redactServiceError(error)}`)
  process.exitCode = 1
}
