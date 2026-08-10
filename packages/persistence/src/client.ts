import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

import { MAX_BOARD_MEMBERS } from "@tuiscrib/contracts"

import {
  boards,
  memberships,
  serviceMetadata,
  terminalSessions,
  users,
} from "./schema.ts"

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

export type AuthenticateTerminalSessionInput = {
  credentialHash: string
  now: Date
  expiresAt: Date
}

export type TerminalSessionAuthentication =
  | { user: Pick<AuthUserRecord, "id" | "username"> }
  | { status: "expired" | "revoked" }
  | null

export type RevokeTerminalSessionInput = {
  credentialHash: string
  now: Date
}

export type CreateBoardInput = {
  publicId: string
  name: string
  ownerUserId: number
  joinCodeHash: string
  now: Date
}

export type BoardSummaryRecord = {
  id: string
  name: string
  role: "owner" | "member"
}

export type CreateBoardResult =
  | { kind: "created"; board: BoardSummaryRecord }
  | { kind: "owned_board_limit" }

export type JoinBoardInput = {
  userId: number
  joinCodeHash: string
  now: Date
}

export type JoinBoardResult =
  | { kind: "joined"; board: BoardSummaryRecord }
  | { kind: "invalid_join_code" }
  | { kind: "already_member" }
  | { kind: "board_capacity" }

export type LeaveBoardInput = {
  userId: number
  publicId: string
  now: Date
}

export type LeaveBoardResult =
  | { kind: "left" }
  | { kind: "not_member" }
  | { kind: "owner_cannot_leave" }

export type ListBoardsInput = {
  userId: number
  nameFilter: string
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
  authenticateTerminalSession(
    input: AuthenticateTerminalSessionInput,
  ): Promise<TerminalSessionAuthentication>
  revokeTerminalSession(input: RevokeTerminalSessionInput): Promise<void>
  createBoard(input: CreateBoardInput): Promise<CreateBoardResult>
  joinBoard(input: JoinBoardInput): Promise<JoinBoardResult>
  leaveBoard(input: LeaveBoardInput): Promise<LeaveBoardResult>
  listBoards(input: ListBoardsInput): Promise<BoardSummaryRecord[]>
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

    async createBoard(input) {
      return database.transaction(async (transaction) => {
        const owners = await transaction
          .update(users)
          .set({ ownedBoardCount: sql`${users.ownedBoardCount} + 1` })
          .where(
            and(
              eq(users.id, input.ownerUserId),
              lt(users.ownedBoardCount, 20),
            ),
          )
          .returning({ id: users.id })

        if (!owners[0]) {
          return { kind: "owned_board_limit" as const }
        }

        const insertedBoards = await transaction
          .insert(boards)
          .values({
            publicId: input.publicId,
            name: input.name,
            ownerUserId: input.ownerUserId,
            joinCodeHash: input.joinCodeHash,
            createdAt: input.now,
          })
          .returning({ id: boards.id, publicId: boards.publicId, name: boards.name })

        const board = insertedBoards[0]
        if (!board) {
          throw new Error("Board could not be created")
        }

        await transaction.insert(memberships).values({
          boardId: board.id,
          userId: input.ownerUserId,
          role: "owner",
          createdAt: input.now,
        })

        return {
          kind: "created" as const,
          board: { id: board.publicId, name: board.name, role: "owner" as const },
        }
      })
    },

    async joinBoard(input) {
      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({
            id: boards.id,
            publicId: boards.publicId,
            name: boards.name,
          })
          .from(boards)
          .where(eq(boards.joinCodeHash, input.joinCodeHash))
          .for("update")

        const board = boardRows[0]
        if (!board) {
          return { kind: "invalid_join_code" as const }
        }

        const existingMembership = await transaction
          .select({ role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.boardId, board.id),
              eq(memberships.userId, input.userId),
            ),
          )
          .limit(1)

        if (existingMembership[0]) {
          return { kind: "already_member" as const }
        }

        const memberCount = await transaction
          .select({ count: sql<number>`count(*)` })
          .from(memberships)
          .where(eq(memberships.boardId, board.id))

        if (Number(memberCount[0]?.count ?? 0) >= MAX_BOARD_MEMBERS) {
          return { kind: "board_capacity" as const }
        }

        await transaction.insert(memberships).values({
          boardId: board.id,
          userId: input.userId,
          role: "member",
          createdAt: input.now,
        })

        return {
          kind: "joined" as const,
          board: { id: board.publicId, name: board.name, role: "member" as const },
        }
      })
    },

    async leaveBoard(input) {
      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({ id: boards.id })
          .from(boards)
          .where(eq(boards.publicId, input.publicId))
          .for("update")

        const board = boardRows[0]
        if (!board) {
          return { kind: "not_member" as const }
        }

        const memberRows = await transaction
          .select({ role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.boardId, board.id),
              eq(memberships.userId, input.userId),
            ),
          )
          .limit(1)

        const membership = memberRows[0]
        if (!membership) {
          return { kind: "not_member" as const }
        }
        if (membership.role === "owner") {
          return { kind: "owner_cannot_leave" as const }
        }

        await transaction
          .delete(memberships)
          .where(
            and(
              eq(memberships.boardId, board.id),
              eq(memberships.userId, input.userId),
            ),
          )

        return { kind: "left" as const }
      })
    },

    async listBoards(input) {
      const conditions = [eq(memberships.userId, input.userId)]
      if (input.nameFilter.length > 0) {
        const escapedFilter = input.nameFilter
          .replaceAll("!", "!!")
          .replaceAll("%", "!%")
          .replaceAll("_", "!_")
        conditions.push(
          sql`${boards.name} ILIKE ${`%${escapedFilter}%`} ESCAPE '!'`,
        )
      }

      const result = await database
        .select({
          id: boards.publicId,
          name: boards.name,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(boards, eq(memberships.boardId, boards.id))
        .where(and(...conditions))
        .orderBy(asc(boards.name), asc(boards.id))

      return result.map((board) => ({
        id: board.id,
        name: board.name,
        role: board.role as "owner" | "member",
      }))
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

    async authenticateTerminalSession(input) {
      return database.transaction(async (transaction) => {
        const sessions = await transaction
          .select({
            sessionId: terminalSessions.id,
            userId: users.id,
            username: users.username,
            expiresAt: terminalSessions.expiresAt,
            revokedAt: terminalSessions.revokedAt,
          })
          .from(terminalSessions)
          .innerJoin(users, eq(terminalSessions.userId, users.id))
          .where(eq(terminalSessions.credentialHash, input.credentialHash))
          .limit(1)

        const session = sessions[0]
        if (!session) {
          return null
        }
        if (session.revokedAt) {
          return { status: "revoked" as const }
        }
        if (session.expiresAt.getTime() <= input.now.getTime()) {
          return { status: "expired" as const }
        }

        const updated = await transaction
          .update(terminalSessions)
          .set({ lastActivityAt: input.now, expiresAt: input.expiresAt })
          .where(
            and(
              eq(terminalSessions.id, session.sessionId),
              isNull(terminalSessions.revokedAt),
              gt(terminalSessions.expiresAt, input.now),
            ),
          )
          .returning({ id: terminalSessions.id })

        if (!updated[0]) {
          return { status: "expired" as const }
        }

        return { user: { id: session.userId, username: session.username } }
      })
    },

    async revokeTerminalSession(input) {
      await database
        .update(terminalSessions)
        .set({ revokedAt: input.now })
        .where(
          and(
            eq(terminalSessions.credentialHash, input.credentialHash),
            isNull(terminalSessions.revokedAt),
          ),
        )
    },

    async reset() {
      await database.delete(boards)
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
