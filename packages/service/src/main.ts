import { createPersistence } from "@tuiscrib/persistence"

import { createServiceApp } from "./app.ts"
import {
  createBoardCollaboration,
  type BoardWebSocketData,
} from "./collaboration.ts"
import {
  loadServiceEnvironment,
  redactServiceError,
} from "./config.ts"

async function main(): Promise<void> {
  const configuration = loadServiceEnvironment()
  let server: Bun.Server<BoardWebSocketData> | undefined
  let migrationPersistence: ReturnType<typeof createPersistence> | undefined
  let persistence: ReturnType<typeof createPersistence> | undefined

  try {
    if (!configuration.migrationsPredeployed) {
      migrationPersistence = createPersistence({
        databaseUrl: configuration.migrationDatabaseUrl,
        maxConnections: configuration.databasePoolMax,
        connectTimeoutSeconds: configuration.databaseConnectTimeoutSeconds,
        idleTimeoutSeconds: configuration.databaseIdleTimeoutSeconds,
        migrationLockTimeoutMs: configuration.migrationLockTimeoutMs,
        migrationLockPollMs: configuration.migrationLockPollMs,
      })
      await migrationPersistence.migrate()
      await migrationPersistence.healthCheck()
      await migrationPersistence.close()
      migrationPersistence = undefined
    }
    persistence = createPersistence({
      databaseUrl: configuration.databaseUrl,
      maxConnections: configuration.databasePoolMax,
      connectTimeoutSeconds: configuration.databaseConnectTimeoutSeconds,
      idleTimeoutSeconds: configuration.databaseIdleTimeoutSeconds,
      migrationLockTimeoutMs: configuration.migrationLockTimeoutMs,
      migrationLockPollMs: configuration.migrationLockPollMs,
    })
    await persistence.healthCheck()

    const collaboration = createBoardCollaboration({ persistence })
    const app = createServiceApp({ persistence, collaboration })
    server = Bun.serve({
      hostname: configuration.host,
      port: configuration.port,
      maxRequestBodySize: 256 * 1024,
      async fetch(request, bunServer) {
        const result = await collaboration.handleUpgrade(request, bunServer)
        if (result !== null) {
          return result
        }
        return app.fetch(request)
      },
      websocket: {
        ...collaboration.websocket,
        idleTimeout: configuration.websocketIdleTimeoutSeconds,
        maxPayloadLength: 128 * 1024,
      },
      error(error) {
        console.error(`Tuiscrib Service request failed: ${redactServiceError(error)}`)
        return new Response("service unavailable", { status: 503 })
      },
    })

    console.log(`Tuiscrib Service listening on port ${server.port}`)

    let shutdownPromise: Promise<void> | null = null
    const shutdown = (): Promise<void> => {
      shutdownPromise ??= (async () => {
        await server?.stop(true)
        await persistence?.close()
      })()
      return shutdownPromise
    }

    process.once("SIGINT", () => void shutdown())
    process.once("SIGTERM", () => void shutdown())
  } catch (error) {
    await server?.stop(true).catch(() => undefined)
    await migrationPersistence?.close().catch(() => undefined)
    await persistence?.close().catch(() => undefined)
    throw error
  }
}

try {
  await main()
} catch (error) {
  console.error(`Tuiscrib Service startup failed: ${redactServiceError(error)}`)
  process.exitCode = 1
}
