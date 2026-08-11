import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { aliasedTable, and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

import {
  MAX_BOARD_MEMBERS,
  MAX_STICKY_NOTES,
  compareStickyNoteStackingOrder,
  stickyNoteColorSchema,
  stickyNoteMovementDirectionSchema,
  stickyNotePositionSchema,
  stickyNoteTextSchema,
  type StickyNote,
  type StickyNoteColor,
  type StickyNotePosition,
  type StickyNoteMovementDirection,
  type StickyNoteStackingDirection,
} from "@tuiscrib/contracts"

import {
  boards,
  memberships,
  serviceMetadata,
  stickyNotes,
  terminalSessions,
  users,
} from "./schema.ts"

const stickyNoteAuthors = aliasedTable(users, "sticky_note_authors")
const stickyNoteEditors = aliasedTable(users, "sticky_note_editors")

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

export type RenameBoardInput = {
  userId: number
  publicId: string
  name: string
}

export type RenameBoardResult =
  | { kind: "renamed"; board: BoardSummaryRecord }
  | { kind: "not_found" }
  | { kind: "not_owner" }

export type RotateJoinCodeInput = {
  userId: number
  publicId: string
  joinCodeHash: string
}

export type RotateJoinCodeResult =
  | { kind: "rotated"; board: BoardSummaryRecord }
  | { kind: "not_found" }
  | { kind: "not_owner" }

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

export type DeleteBoardInput = {
  userId: number
  publicId: string
}

export type DeleteBoardResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "not_owner" }

export type ListBoardsInput = {
  userId: number
  nameFilter: string
}

export type OpenBoardInput = {
  userId: number
  publicId: string
}

export type OpenBoardRecord = {
  board: BoardSummaryRecord
  revision: number
  stickyNotes?: StickyNoteRecord[]
}

export type StickyNoteRecord = StickyNote

export type CreateStickyNoteInput = {
  publicId: string
  boardId: string
  userId: number
  text: string
  position: StickyNotePosition
  color: StickyNoteColor
  now: Date
}

export type CreateStickyNoteResult =
  | { kind: "created"; stickyNote: StickyNoteRecord; revision: number }
  | { kind: "empty_text" }
  | { kind: "invalid_text" }
  | { kind: "not_found" }
  | { kind: "not_member" }
  | { kind: "board_capacity" }

export type UpdateStickyNoteTextInput = {
  boardId: string
  stickyNoteId: string
  userId: number
  text: string
  expectedTextVersion: number
  now: Date
}

export type UpdateStickyNoteTextResult =
  | { kind: "updated"; stickyNote: StickyNoteRecord; revision: number }
  | { kind: "text_version_conflict"; stickyNote: StickyNoteRecord; revision: number }
  | { kind: "invalid_text" }
  | { kind: "not_found" }
  | { kind: "not_member" }

export type DeleteStickyNoteInput = {
  boardId: string
  stickyNoteId: string
  userId: number
}

export type DeleteStickyNoteResult =
  | {
      kind: "deleted"
      stickyNoteId: string
      revision: number
      affectedStickyNotes?: StickyNoteRecord[]
    }
  | { kind: "not_found"; revision?: number }
  | { kind: "not_member" }

export type RecolorStickyNoteInput = {
  boardId: string
  stickyNoteId: string
  userId: number
  color: StickyNoteColor
}

export type RecolorStickyNoteResult =
  | { kind: "recolored"; stickyNote: StickyNoteRecord; revision: number }
  | { kind: "invalid_color" }
  | { kind: "not_found" }
  | { kind: "not_member" }

export type ReorderStickyNoteInput = {
  boardId: string
  stickyNoteId: string
  userId: number
  direction: StickyNoteStackingDirection
}

export type ReorderStickyNoteResult =
  | {
      kind: "reordered"
      stickyNote: StickyNoteRecord
      affectedStickyNotes?: StickyNoteRecord[]
      revision: number
    }
  | { kind: "at_boundary"; stickyNote: StickyNoteRecord; revision: number }
  | { kind: "not_found" }
  | { kind: "not_member" }

export type MoveStickyNoteInput = {
  boardId: string
  stickyNoteId: string
  userId: number
  direction: StickyNoteMovementDirection
}

export type MoveStickyNoteResult =
  | { kind: "moved"; stickyNote: StickyNoteRecord; revision: number }
  | { kind: "at_boundary"; stickyNote: StickyNoteRecord; revision: number }
  | { kind: "invalid_direction" }
  | { kind: "not_found" }
  | { kind: "not_member" }

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
  renameBoard(input: RenameBoardInput): Promise<RenameBoardResult>
  rotateJoinCode(input: RotateJoinCodeInput): Promise<RotateJoinCodeResult>
  joinBoard(input: JoinBoardInput): Promise<JoinBoardResult>
  leaveBoard(input: LeaveBoardInput): Promise<LeaveBoardResult>
  deleteBoard(input: DeleteBoardInput): Promise<DeleteBoardResult>
  listBoards(input: ListBoardsInput): Promise<BoardSummaryRecord[]>
  openBoard(input: OpenBoardInput): Promise<OpenBoardRecord | null>
  createStickyNote(input: CreateStickyNoteInput): Promise<CreateStickyNoteResult>
  updateStickyNoteText(input: UpdateStickyNoteTextInput): Promise<UpdateStickyNoteTextResult>
  deleteStickyNote(input: DeleteStickyNoteInput): Promise<DeleteStickyNoteResult>
  recolorStickyNote(input: RecolorStickyNoteInput): Promise<RecolorStickyNoteResult>
  reorderStickyNote(input: ReorderStickyNoteInput): Promise<ReorderStickyNoteResult>
  moveStickyNote(input: MoveStickyNoteInput): Promise<MoveStickyNoteResult>
  reset(): Promise<void>
  close(): Promise<void>
}

export type PersistenceOptions = {
  databaseUrl: string
  applicationName?: string
  migrationsFolder?: string
  maxConnections?: number
  connectTimeoutSeconds?: number
  idleTimeoutSeconds?: number
  maxLifetimeSeconds?: number
  migrationLockTimeoutMs?: number
  migrationLockPollMs?: number
}

const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url))
export const MIGRATION_LOCK_NAME = "tuiscrib:drizzle-migrations"
export const MIN_PERSISTENCE_POOL_MAX = 2
export const MAX_PERSISTENCE_POOL_MAX = 8

function toStickyNoteRecord(note: {
  id: string
  text: string
  textVersion: number
  positionX: number
  positionY: number
  color: string
  stackingOrder: number
  createdAt: Date
  lastEditedAt: Date
  authoredByUsername: string
  lastEditedByUsername: string
}): StickyNoteRecord {
  return {
    id: note.id,
    text: note.text,
    textVersion: note.textVersion,
    position: { x: note.positionX, y: note.positionY },
    color: stickyNoteColorSchema.parse(note.color),
    stackingOrder: note.stackingOrder,
    authorship: { member: { username: note.authoredByUsername } },
    createdAt: note.createdAt.toISOString(),
    lastEdit: {
      member: { username: note.lastEditedByUsername },
      at: note.lastEditedAt.toISOString(),
    },
  }
}

export function createPersistence(options: PersistenceOptions): Persistence {
  const maxConnections = options.maxConnections ?? 4
  if (
    !Number.isInteger(maxConnections) ||
    maxConnections < MIN_PERSISTENCE_POOL_MAX ||
    maxConnections > MAX_PERSISTENCE_POOL_MAX
  ) {
    throw new Error(`Persistence pool max must be an integer from ${MIN_PERSISTENCE_POOL_MAX} through ${MAX_PERSISTENCE_POOL_MAX}.`)
  }
  const client = postgres(options.databaseUrl, {
    max: maxConnections,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    max_lifetime: options.maxLifetimeSeconds ?? 300,
    connection: { application_name: options.applicationName ?? "tuiscrib-service" },
    prepare: false,
  })
  const database = drizzle(client)
  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder

  return {
    async migrate() {
      const reservedClient = await client.reserve()
      let lockAcquired = false
      try {
        const deadline = Date.now() + (options.migrationLockTimeoutMs ?? 30_000)
        while (!lockAcquired) {
          const result = await reservedClient`
            select pg_try_advisory_lock(hashtext(${MIGRATION_LOCK_NAME})) as acquired
          `
          lockAcquired = result[0]?.acquired === true
          if (lockAcquired) {
            break
          }
          if (Date.now() >= deadline) {
            throw new Error("database migration lock could not be acquired before the timeout")
          }
          await delay(options.migrationLockPollMs ?? 100)
        }

        // postgres.js reserved clients intentionally expose only the query
        // function and release handle. Keep the advisory lock on that session
        // while Drizzle uses one of the remaining bounded pool connections for
        // its transactional migration runner.
        await migrate(database, { migrationsFolder })
      } finally {
        if (lockAcquired) {
          await reservedClient`
            select pg_advisory_unlock(hashtext(${MIGRATION_LOCK_NAME}))
          `.catch(() => undefined)
        }
        await reservedClient.release()
      }
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

    async renameBoard(input) {
      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({
            id: boards.id,
            publicId: boards.publicId,
            name: boards.name,
            ownerUserId: boards.ownerUserId,
          })
          .from(boards)
          .where(eq(boards.publicId, input.publicId))
          .for("update")

        const board = boardRows[0]
        if (!board) {
          return { kind: "not_found" as const }
        }
        if (board.ownerUserId !== input.userId) {
          return { kind: "not_owner" as const }
        }

        const updatedBoards = await transaction
          .update(boards)
          .set({ name: input.name })
          .where(eq(boards.id, board.id))
          .returning({ publicId: boards.publicId, name: boards.name })
        const updatedBoard = updatedBoards[0]
        if (!updatedBoard) {
          throw new Error("Board could not be renamed")
        }

        return {
          kind: "renamed" as const,
          board: {
            id: updatedBoard.publicId,
            name: updatedBoard.name,
            role: "owner" as const,
          },
        }
      })
    },

    async rotateJoinCode(input) {
      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({
            id: boards.id,
            publicId: boards.publicId,
            name: boards.name,
            ownerUserId: boards.ownerUserId,
          })
          .from(boards)
          .where(eq(boards.publicId, input.publicId))
          .for("update")

        const board = boardRows[0]
        if (!board) {
          return { kind: "not_found" as const }
        }
        if (board.ownerUserId !== input.userId) {
          return { kind: "not_owner" as const }
        }

        const updatedBoards = await transaction
          .update(boards)
          .set({ joinCodeHash: input.joinCodeHash })
          .where(eq(boards.id, board.id))
          .returning({ publicId: boards.publicId, name: boards.name })
        const updatedBoard = updatedBoards[0]
        if (!updatedBoard) {
          throw new Error("Join Code could not be rotated")
        }

        return {
          kind: "rotated" as const,
          board: {
            id: updatedBoard.publicId,
            name: updatedBoard.name,
            role: "owner" as const,
          },
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

    async deleteBoard(input) {
      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({ id: boards.id, ownerUserId: boards.ownerUserId })
          .from(boards)
          .where(eq(boards.publicId, input.publicId))
          .for("update")

        const board = boardRows[0]
        if (!board) {
          return { kind: "not_found" as const }
        }
        if (board.ownerUserId !== input.userId) {
          return { kind: "not_owner" as const }
        }

        const deletedBoards = await transaction
          .delete(boards)
          .where(eq(boards.id, board.id))
          .returning({ id: boards.id })
        if (!deletedBoards[0]) {
          throw new Error("Board could not be deleted")
        }

        const owners = await transaction
          .update(users)
          .set({ ownedBoardCount: sql`${users.ownedBoardCount} - 1` })
          .where(
            and(
              eq(users.id, board.ownerUserId),
              gt(users.ownedBoardCount, 0),
            ),
          )
          .returning({ id: users.id })
        if (!owners[0]) {
          throw new Error("Owned Board count could not be decremented")
        }

        return { kind: "deleted" as const }
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

    async openBoard(input) {
      const result = await database
        .select({
          boardId: boards.id,
          id: boards.publicId,
          name: boards.name,
          role: memberships.role,
          revision: boards.revision,
        })
        .from(memberships)
        .innerJoin(boards, eq(memberships.boardId, boards.id))
        .where(
          and(
            eq(memberships.userId, input.userId),
            eq(boards.publicId, input.publicId),
          ),
        )
        .limit(1)

      const board = result[0]
      if (!board) {
        return null
      }

      const noteRows = await database
        .select({
          id: stickyNotes.publicId,
          text: stickyNotes.text,
          textVersion: stickyNotes.textVersion,
          positionX: stickyNotes.positionX,
          positionY: stickyNotes.positionY,
          color: stickyNotes.color,
          stackingOrder: stickyNotes.stackingOrder,
          createdAt: stickyNotes.createdAt,
          lastEditedAt: stickyNotes.lastEditedAt,
          authoredByUsername: stickyNoteAuthors.username,
          lastEditedByUsername: stickyNoteEditors.username,
        })
        .from(stickyNotes)
        .innerJoin(stickyNoteAuthors, eq(stickyNotes.authoredByUserId, stickyNoteAuthors.id))
        .innerJoin(stickyNoteEditors, eq(stickyNotes.lastEditedByUserId, stickyNoteEditors.id))
        .where(eq(stickyNotes.boardId, board.boardId))
        .orderBy(
          asc(stickyNotes.stackingOrder),
          asc(sql`${stickyNotes.publicId} COLLATE "C"`),
        )

      return {
        board: {
          id: board.id,
          name: board.name,
          role: board.role as "owner" | "member",
        },
        revision: board.revision,
        stickyNotes: noteRows.map(toStickyNoteRecord),
      }
    },

    async createStickyNote(input) {
      if (input.text.length === 0) {
        return { kind: "empty_text" as const }
      }
      if (
        !stickyNoteTextSchema.safeParse(input.text).success ||
        !stickyNotePositionSchema.safeParse(input.position).success ||
        !stickyNoteColorSchema.safeParse(input.color).success
      ) {
        return { kind: "invalid_text" as const }
      }

      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({ id: boards.id })
          .from(boards)
          .where(eq(boards.publicId, input.boardId))
          .for("update")
        const board = boardRows[0]
        if (!board) {
          return { kind: "not_found" as const }
        }

        const memberRows = await transaction
          .select({ username: users.username })
          .from(memberships)
          .innerJoin(users, eq(memberships.userId, users.id))
          .where(
            and(
              eq(memberships.boardId, board.id),
              eq(memberships.userId, input.userId),
            ),
          )
          .limit(1)
        const member = memberRows[0]
        if (!member) {
          return { kind: "not_member" as const }
        }

        const noteCountRows = await transaction
          .select({ count: sql<number>`count(*)` })
          .from(stickyNotes)
          .where(eq(stickyNotes.boardId, board.id))
        const noteCount = Number(noteCountRows[0]?.count ?? 0)
        if (noteCount >= MAX_STICKY_NOTES) {
          return { kind: "board_capacity" as const }
        }

        await transaction.insert(stickyNotes).values({
          publicId: input.publicId,
          boardId: board.id,
          authoredByUserId: input.userId,
          text: input.text,
          textVersion: 1,
          positionX: input.position.x,
          positionY: input.position.y,
          color: input.color,
          stackingOrder: noteCount,
          createdAt: input.now,
          lastEditedByUserId: input.userId,
          lastEditedAt: input.now,
        })

        const revisionRows = await transaction
          .update(boards)
          .set({ revision: sql`${boards.revision} + 1` })
          .where(eq(boards.id, board.id))
          .returning({ revision: boards.revision })
        const revision = revisionRows[0]?.revision
        if (revision === undefined) {
          throw new Error("Board revision could not be advanced")
        }

        return {
          kind: "created" as const,
          revision,
          stickyNote: {
            id: input.publicId,
            text: input.text,
            textVersion: 1,
            position: input.position,
            color: input.color,
            stackingOrder: noteCount,
            authorship: { member: { username: member.username } },
            createdAt: input.now.toISOString(),
            lastEdit: {
              member: { username: member.username },
              at: input.now.toISOString(),
            },
          },
        }
      })
    },

    async updateStickyNoteText(input) {
      if (
        !Number.isInteger(input.expectedTextVersion) ||
        input.expectedTextVersion < 1 ||
        !stickyNoteTextSchema.safeParse(input.text).success
      ) {
        return { kind: "invalid_text" as const }
      }

      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({ id: boards.id, revision: boards.revision })
          .from(boards)
          .where(eq(boards.publicId, input.boardId))
          .for("update")
        const board = boardRows[0]
        if (!board) {
          return { kind: "not_found" as const }
        }

        const memberRows = await transaction
          .select({ username: users.username })
          .from(memberships)
          .innerJoin(users, eq(memberships.userId, users.id))
          .where(
            and(
              eq(memberships.boardId, board.id),
              eq(memberships.userId, input.userId),
            ),
          )
          .limit(1)
        const member = memberRows[0]
        if (!member) {
          return { kind: "not_member" as const }
        }

        const noteRows = await transaction
          .select({
            internalId: stickyNotes.id,
            publicId: stickyNotes.publicId,
            text: stickyNotes.text,
            textVersion: stickyNotes.textVersion,
            positionX: stickyNotes.positionX,
            positionY: stickyNotes.positionY,
            color: stickyNotes.color,
            stackingOrder: stickyNotes.stackingOrder,
            createdAt: stickyNotes.createdAt,
            authoredByUserId: stickyNotes.authoredByUserId,
            lastEditedByUserId: stickyNotes.lastEditedByUserId,
            lastEditedAt: stickyNotes.lastEditedAt,
          })
          .from(stickyNotes)
          .where(
            and(
              eq(stickyNotes.boardId, board.id),
              eq(stickyNotes.publicId, input.stickyNoteId),
            ),
          )
          .for("update")
        const note = noteRows[0]
        if (!note) {
          return { kind: "not_found" as const }
        }

        const authorRows = await transaction
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, note.authoredByUserId))
          .limit(1)
        const lastEditorRows = await transaction
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, note.lastEditedByUserId))
          .limit(1)
        const authoredByUsername = authorRows[0]?.username
        const lastEditedByUsername = lastEditorRows[0]?.username
        if (!authoredByUsername || !lastEditedByUsername) {
          throw new Error("Sticky Note attribution could not be loaded")
        }

        const currentStickyNote = toStickyNoteRecord({
          id: note.publicId,
          text: note.text,
          textVersion: note.textVersion,
          positionX: note.positionX,
          positionY: note.positionY,
          color: note.color,
          stackingOrder: note.stackingOrder,
          createdAt: note.createdAt,
          lastEditedAt: note.lastEditedAt,
          authoredByUsername,
          lastEditedByUsername,
        })
        if (note.textVersion !== input.expectedTextVersion) {
          return {
            kind: "text_version_conflict" as const,
            stickyNote: currentStickyNote,
            revision: board.revision,
          }
        }

        const updatedRows = await transaction
          .update(stickyNotes)
          .set({
            text: input.text,
            textVersion: sql`${stickyNotes.textVersion} + 1`,
            lastEditedByUserId: input.userId,
            lastEditedAt: input.now,
          })
          .where(eq(stickyNotes.id, note.internalId))
          .returning({ id: stickyNotes.id })
        if (!updatedRows[0]) {
          throw new Error("Sticky Note text could not be updated")
        }

        const revisionRows = await transaction
          .update(boards)
          .set({ revision: sql`${boards.revision} + 1` })
          .where(eq(boards.id, board.id))
          .returning({ revision: boards.revision })
        const revision = revisionRows[0]?.revision
        if (revision === undefined) {
          throw new Error("Board revision could not be advanced")
        }

        return {
          kind: "updated" as const,
          revision,
          stickyNote: toStickyNoteRecord({
            id: note.publicId,
            text: input.text,
            textVersion: note.textVersion + 1,
            positionX: note.positionX,
            positionY: note.positionY,
            color: note.color,
            stackingOrder: note.stackingOrder,
            createdAt: note.createdAt,
            lastEditedAt: input.now,
            authoredByUsername,
            lastEditedByUsername: member.username,
          }),
        }
      })
    },

    async deleteStickyNote(input) {
      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({ id: boards.id, revision: boards.revision })
          .from(boards)
          .where(eq(boards.publicId, input.boardId))
          .for("update")
        const board = boardRows[0]
        if (!board) {
          return { kind: "not_found" as const }
        }

        const memberRows = await transaction
          .select({ username: users.username })
          .from(memberships)
          .innerJoin(users, eq(memberships.userId, users.id))
          .where(
            and(
              eq(memberships.boardId, board.id),
              eq(memberships.userId, input.userId),
            ),
          )
          .limit(1)
        if (!memberRows[0]) {
          return { kind: "not_member" as const }
        }

        const noteRows = await transaction
          .select({
            internalId: stickyNotes.id,
            publicId: stickyNotes.publicId,
            stackingOrder: stickyNotes.stackingOrder,
          })
          .from(stickyNotes)
          .where(
            and(
              eq(stickyNotes.boardId, board.id),
              eq(stickyNotes.publicId, input.stickyNoteId),
            ),
          )
          .for("update")
        const note = noteRows[0]
        if (!note) {
          return { kind: "not_found" as const, revision: board.revision }
        }

        const notesAfterTarget = await transaction
          .select({
            internalId: stickyNotes.id,
            publicId: stickyNotes.publicId,
            text: stickyNotes.text,
            textVersion: stickyNotes.textVersion,
            positionX: stickyNotes.positionX,
            positionY: stickyNotes.positionY,
            color: stickyNotes.color,
            stackingOrder: stickyNotes.stackingOrder,
            createdAt: stickyNotes.createdAt,
            lastEditedAt: stickyNotes.lastEditedAt,
            authoredByUsername: stickyNoteAuthors.username,
            lastEditedByUsername: stickyNoteEditors.username,
          })
          .from(stickyNotes)
          .innerJoin(stickyNoteAuthors, eq(stickyNotes.authoredByUserId, stickyNoteAuthors.id))
          .innerJoin(stickyNoteEditors, eq(stickyNotes.lastEditedByUserId, stickyNoteEditors.id))
          .where(
            and(
              eq(stickyNotes.boardId, board.id),
              gt(stickyNotes.stackingOrder, note.stackingOrder),
            ),
          )
          .orderBy(asc(stickyNotes.stackingOrder), asc(stickyNotes.id))
          .for("update")

        const deletedRows = await transaction
          .delete(stickyNotes)
          .where(eq(stickyNotes.id, note.internalId))
          .returning({ id: stickyNotes.id })
        if (!deletedRows[0]) {
          throw new Error("Sticky Note could not be deleted")
        }

        if (notesAfterTarget.length > 0) {
          await transaction
            .update(stickyNotes)
            .set({ stackingOrder: sql`${stickyNotes.stackingOrder} - 1` })
            .where(
              and(
                eq(stickyNotes.boardId, board.id),
                gt(stickyNotes.stackingOrder, note.stackingOrder),
              ),
            )
        }

        const revisionRows = await transaction
          .update(boards)
          .set({ revision: sql`${boards.revision} + 1` })
          .where(eq(boards.id, board.id))
          .returning({ revision: boards.revision })
        const revision = revisionRows[0]?.revision
        if (revision === undefined) {
          throw new Error("Board revision could not be advanced")
        }

        return {
          kind: "deleted" as const,
          stickyNoteId: note.publicId,
          revision,
          ...(notesAfterTarget.length > 0
            ? {
                affectedStickyNotes: notesAfterTarget
                  .map((affectedNote) => toStickyNoteRecord({
                    ...affectedNote,
                    id: affectedNote.publicId,
                    stackingOrder: affectedNote.stackingOrder - 1,
                  }))
                  .sort(compareStickyNoteStackingOrder),
              }
            : {}),
        }
      })
    },

    async recolorStickyNote(input) {
      if (!stickyNoteColorSchema.safeParse(input.color).success) {
        return { kind: "invalid_color" as const }
      }

      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({ id: boards.id, revision: boards.revision })
          .from(boards)
          .where(eq(boards.publicId, input.boardId))
          .for("update")
        const board = boardRows[0]
        if (!board) {
          return { kind: "not_found" as const }
        }

        const memberRows = await transaction
          .select({ username: users.username })
          .from(memberships)
          .innerJoin(users, eq(memberships.userId, users.id))
          .where(
            and(
              eq(memberships.boardId, board.id),
              eq(memberships.userId, input.userId),
            ),
          )
          .limit(1)
        const member = memberRows[0]
        if (!member) {
          return { kind: "not_member" as const }
        }

        const noteRows = await transaction
          .select({
            internalId: stickyNotes.id,
            publicId: stickyNotes.publicId,
            text: stickyNotes.text,
            textVersion: stickyNotes.textVersion,
            positionX: stickyNotes.positionX,
            positionY: stickyNotes.positionY,
            color: stickyNotes.color,
            stackingOrder: stickyNotes.stackingOrder,
            createdAt: stickyNotes.createdAt,
            authoredByUserId: stickyNotes.authoredByUserId,
            lastEditedByUserId: stickyNotes.lastEditedByUserId,
            lastEditedAt: stickyNotes.lastEditedAt,
          })
          .from(stickyNotes)
          .where(
            and(
              eq(stickyNotes.boardId, board.id),
              eq(stickyNotes.publicId, input.stickyNoteId),
            ),
          )
          .for("update")
        const note = noteRows[0]
        if (!note) {
          return { kind: "not_found" as const }
        }

        const authorRows = await transaction
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, note.authoredByUserId))
          .limit(1)
        const lastEditorRows = await transaction
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, note.lastEditedByUserId))
          .limit(1)
        const authoredByUsername = authorRows[0]?.username
        const lastEditedByUsername = lastEditorRows[0]?.username
        if (!authoredByUsername || !lastEditedByUsername) {
          throw new Error("Sticky Note attribution could not be loaded")
        }

        const updatedRows = await transaction
          .update(stickyNotes)
          .set({ color: input.color })
          .where(eq(stickyNotes.id, note.internalId))
          .returning({ id: stickyNotes.id })
        if (!updatedRows[0]) {
          throw new Error("Sticky Note Color could not be updated")
        }

        const revisionRows = await transaction
          .update(boards)
          .set({ revision: sql`${boards.revision} + 1` })
          .where(eq(boards.id, board.id))
          .returning({ revision: boards.revision })
        const revision = revisionRows[0]?.revision
        if (revision === undefined) {
          throw new Error("Board revision could not be advanced")
        }

        return {
          kind: "recolored" as const,
          revision,
          stickyNote: toStickyNoteRecord({
            id: note.publicId,
            text: note.text,
            textVersion: note.textVersion,
            positionX: note.positionX,
            positionY: note.positionY,
            color: input.color,
            stackingOrder: note.stackingOrder,
            createdAt: note.createdAt,
            lastEditedAt: note.lastEditedAt,
            authoredByUsername,
            lastEditedByUsername,
          }),
        }
      })
    },

    async reorderStickyNote(input) {
      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({ id: boards.id, revision: boards.revision })
          .from(boards)
          .where(eq(boards.publicId, input.boardId))
          .for("update")
        const board = boardRows[0]
        if (!board) {
          return { kind: "not_found" as const }
        }

        const memberRows = await transaction
          .select({ username: users.username })
          .from(memberships)
          .innerJoin(users, eq(memberships.userId, users.id))
          .where(
            and(
              eq(memberships.boardId, board.id),
              eq(memberships.userId, input.userId),
            ),
          )
          .limit(1)
        if (!memberRows[0]) {
          return { kind: "not_member" as const }
        }

        const noteRows = await transaction
          .select({
            internalId: stickyNotes.id,
            publicId: stickyNotes.publicId,
            text: stickyNotes.text,
            textVersion: stickyNotes.textVersion,
            positionX: stickyNotes.positionX,
            positionY: stickyNotes.positionY,
            color: stickyNotes.color,
            stackingOrder: stickyNotes.stackingOrder,
            createdAt: stickyNotes.createdAt,
            lastEditedAt: stickyNotes.lastEditedAt,
            authoredByUsername: stickyNoteAuthors.username,
            lastEditedByUsername: stickyNoteEditors.username,
          })
          .from(stickyNotes)
          .innerJoin(stickyNoteAuthors, eq(stickyNotes.authoredByUserId, stickyNoteAuthors.id))
          .innerJoin(stickyNoteEditors, eq(stickyNotes.lastEditedByUserId, stickyNoteEditors.id))
          .where(eq(stickyNotes.boardId, board.id))
          .orderBy(
            asc(stickyNotes.stackingOrder),
            asc(sql`${stickyNotes.publicId} COLLATE "C"`),
          )
          .for("update")

        const noteIndex = noteRows.findIndex((note) => note.publicId === input.stickyNoteId)
        if (noteIndex === -1) {
          return { kind: "not_found" as const }
        }

        const neighborIndex = input.direction === "raise" ? noteIndex + 1 : noteIndex - 1
        const note = noteRows[noteIndex]
        const neighbor = noteRows[neighborIndex]
        if (!note || !neighbor) {
          if (!note) {
            return { kind: "not_found" as const }
          }
          return {
            kind: "at_boundary" as const,
            revision: board.revision,
            stickyNote: toStickyNoteRecord({ ...note, id: note.publicId }),
          }
        }

        await transaction
          .update(stickyNotes)
          .set({ stackingOrder: neighbor.stackingOrder })
          .where(eq(stickyNotes.id, note.internalId))
        await transaction
          .update(stickyNotes)
          .set({ stackingOrder: note.stackingOrder })
          .where(eq(stickyNotes.id, neighbor.internalId))

        const revisionRows = await transaction
          .update(boards)
          .set({ revision: sql`${boards.revision} + 1` })
          .where(eq(boards.id, board.id))
          .returning({ revision: boards.revision })
        const revision = revisionRows[0]?.revision
        if (revision === undefined) {
          throw new Error("Board revision could not be advanced")
        }

        return {
          kind: "reordered" as const,
          revision,
          stickyNote: toStickyNoteRecord({
            ...note,
            id: note.publicId,
            stackingOrder: neighbor.stackingOrder,
          }),
          affectedStickyNotes: [
            toStickyNoteRecord({
              ...note,
              id: note.publicId,
              stackingOrder: neighbor.stackingOrder,
            }),
            toStickyNoteRecord({
              ...neighbor,
              id: neighbor.publicId,
              stackingOrder: note.stackingOrder,
            }),
          ].sort(compareStickyNoteStackingOrder),
        }
      })
    },

    async moveStickyNote(input) {
      if (!stickyNoteMovementDirectionSchema.safeParse(input.direction).success) {
        return { kind: "invalid_direction" as const }
      }

      const delta = {
        up: { x: 0, y: -1 },
        down: { x: 0, y: 1 },
        left: { x: -1, y: 0 },
        right: { x: 1, y: 0 },
      }[input.direction]

      return database.transaction(async (transaction) => {
        const boardRows = await transaction
          .select({ id: boards.id, revision: boards.revision })
          .from(boards)
          .where(eq(boards.publicId, input.boardId))
          .for("update")
        const board = boardRows[0]
        if (!board) {
          return { kind: "not_found" as const }
        }

        const memberRows = await transaction
          .select({ username: users.username })
          .from(memberships)
          .innerJoin(users, eq(memberships.userId, users.id))
          .where(
            and(
              eq(memberships.boardId, board.id),
              eq(memberships.userId, input.userId),
            ),
          )
          .limit(1)
        if (!memberRows[0]) {
          return { kind: "not_member" as const }
        }

        const noteRows = await transaction
          .select({
            internalId: stickyNotes.id,
            publicId: stickyNotes.publicId,
            text: stickyNotes.text,
            textVersion: stickyNotes.textVersion,
            positionX: stickyNotes.positionX,
            positionY: stickyNotes.positionY,
            color: stickyNotes.color,
            stackingOrder: stickyNotes.stackingOrder,
            createdAt: stickyNotes.createdAt,
            lastEditedAt: stickyNotes.lastEditedAt,
            authoredByUsername: stickyNoteAuthors.username,
            lastEditedByUsername: stickyNoteEditors.username,
          })
          .from(stickyNotes)
          .innerJoin(stickyNoteAuthors, eq(stickyNotes.authoredByUserId, stickyNoteAuthors.id))
          .innerJoin(stickyNoteEditors, eq(stickyNotes.lastEditedByUserId, stickyNoteEditors.id))
          .where(
            and(
              eq(stickyNotes.boardId, board.id),
              eq(stickyNotes.publicId, input.stickyNoteId),
            ),
          )
          .for("update")
        const note = noteRows[0]
        if (!note) {
          return { kind: "not_found" as const }
        }

        const currentStickyNote = toStickyNoteRecord({ ...note, id: note.publicId })
        const nextPosition = {
          x: note.positionX + delta.x,
          y: note.positionY + delta.y,
        }
        if (!stickyNotePositionSchema.safeParse(nextPosition).success) {
          return {
            kind: "at_boundary" as const,
            stickyNote: currentStickyNote,
            revision: board.revision,
          }
        }

        const updatedRows = await transaction
          .update(stickyNotes)
          .set({ positionX: nextPosition.x, positionY: nextPosition.y })
          .where(eq(stickyNotes.id, note.internalId))
          .returning({ id: stickyNotes.id })
        if (!updatedRows[0]) {
          throw new Error("Sticky Note Position could not be updated")
        }

        const revisionRows = await transaction
          .update(boards)
          .set({ revision: sql`${boards.revision} + 1` })
          .where(eq(boards.id, board.id))
          .returning({ revision: boards.revision })
        const revision = revisionRows[0]?.revision
        if (revision === undefined) {
          throw new Error("Board revision could not be advanced")
        }

        return {
          kind: "moved" as const,
          revision,
          stickyNote: toStickyNoteRecord({
            ...note,
            id: note.publicId,
            positionX: nextPosition.x,
            positionY: nextPosition.y,
          }),
        }
      })
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
      await client.end({ timeout: 1 })
    },
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
