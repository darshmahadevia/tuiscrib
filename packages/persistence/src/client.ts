import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { eq } from "drizzle-orm"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

import { serviceMetadata } from "./schema.ts"

export type PersistenceHealth = {
  database: "ready"
}

export type Persistence = {
  migrate(): Promise<void>
  healthCheck(): Promise<PersistenceHealth>
  reset(): Promise<void>
  close(): Promise<void>
}

export type PersistenceOptions = {
  databaseUrl: string
  migrationsFolder?: string
  maxConnections?: number
}

const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url))

export function createPersistence(options: PersistenceOptions): Persistence {
  const client = postgres(options.databaseUrl, {
    max: options.maxConnections ?? 4,
    prepare: false,
  })
  const database = drizzle(client)
  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder

  return {
    async migrate() {
      await migrate(database, { migrationsFolder })
    },

    async healthCheck() {
      const probe = await client`select 1::int as ready`
      if (probe[0]?.ready !== 1) {
        throw new Error("database readiness probe failed")
      }

      const marker = await database
        .select({ value: serviceMetadata.value })
        .from(serviceMetadata)
        .where(eq(serviceMetadata.key, "service"))
        .limit(1)

      if (marker[0]?.value !== "tuiscrib") {
        throw new Error("database migration marker is missing")
      }

      return { database: "ready" }
    },

    async reset() {
      await database.delete(serviceMetadata)
      await database.insert(serviceMetadata).values({ key: "service", value: "tuiscrib" })
    },

    async close() {
      await client.end({ timeout: 5 })
    },
  }
}
