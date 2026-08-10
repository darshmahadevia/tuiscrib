import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { eq } from "drizzle-orm"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

import { serviceMetadata, terminalSessions, users } from "./schema.ts"

export type PersistenceHealth = {
  database: "ready"
}

export type AuthUserRecord = {
  id: number
  username: string
  passwordHash: string
}

export type RegisterUserInput = {
  username: string
  passwordHash: string
  credentialHash: string
  now: Date
  expiresAt: Date
}

export type CreateTerminalSessionInput = {
  userId: number
  credentialHash: string
  now: Date
  expiresAt: Date
}

export type RegisteredUser = {
  user: Pick<AuthUserRecord, "id" | "username">
  sessionId: number
}

export type Persistence = {
  migrate(): Promise<void>
  healthCheck(): Promise<PersistenceHealth>
  findUserByUsername(username: string): Promise<AuthUserRecord | null>
  registerUser(input: RegisterUserInput): Promise<RegisteredUser | null>
  createTerminalSession(input: CreateTerminalSessionInput): Promise<{ sessionId: number }>
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

    async findUserByUsername(username) {
      const result = await database
        .select({
          id: users.id,
          username: users.username,
          passwordHash: users.passwordHash,
        })
        .from(users)
        .where(eq(users.username, username))
        .limit(1)

      return result[0] ?? null
    },

    async registerUser(input) {
      return database.transaction(async (transaction) => {
        const insertedUsers = await transaction
          .insert(users)
          .values({
            username: input.username,
            passwordHash: input.passwordHash,
            createdAt: input.now,
          })
          .onConflictDoNothing({ target: users.username })
          .returning({ id: users.id, username: users.username })

        const user = insertedUsers[0]
        if (!user) {
          return null
        }

        const insertedSessions = await transaction
          .insert(terminalSessions)
          .values({
            userId: user.id,
            credentialHash: input.credentialHash,
            createdAt: input.now,
            lastActivityAt: input.now,
            expiresAt: input.expiresAt,
          })
          .returning({ sessionId: terminalSessions.id })

        const session = insertedSessions[0]
        if (!session) {
          throw new Error("terminal session could not be created")
        }

        return { user, sessionId: session.sessionId }
      })
    },

    async createTerminalSession(input) {
      const insertedSessions = await database
        .insert(terminalSessions)
        .values({
          userId: input.userId,
          credentialHash: input.credentialHash,
          createdAt: input.now,
          lastActivityAt: input.now,
          expiresAt: input.expiresAt,
        })
        .returning({ sessionId: terminalSessions.id })

      const session = insertedSessions[0]
      if (!session) {
        throw new Error("terminal session could not be created")
      }

      return session
    },

    async reset() {
      await database.delete(terminalSessions)
      await database.delete(users)
      await database.delete(serviceMetadata)
      await database.insert(serviceMetadata).values({ key: "service", value: "tuiscrib" })
    },

    async close() {
      await client.end({ timeout: 5 })
    },
  }
}
