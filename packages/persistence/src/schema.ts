import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  integer,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

export const serviceMetadata = pgTable("service_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})

export const users = pgTable(
  "users",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    ownedBoardCount: integer("owned_board_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("users_username_unique").on(table.username),
    check(
      "users_username_format_check",
      sql`${table.username} ~ '^[a-z0-9_-]{3,24}$'`,
    ),
    check(
      "users_password_hash_argon2id_check",
      sql`${table.passwordHash} LIKE '$argon2id$%'`,
    ),
    check(
      "users_owned_board_count_check",
      sql`${table.ownedBoardCount} >= 0 AND ${table.ownedBoardCount} <= 20`,
    ),
  ],
)

export const terminalSessions = pgTable(
  "terminal_sessions",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialHash: text("credential_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("terminal_sessions_credential_hash_unique").on(table.credentialHash),
    index("terminal_sessions_user_id_idx").on(table.userId),
    check(
      "terminal_sessions_credential_hash_format_check",
      sql`length(${table.credentialHash}) = 64`,
    ),
  ],
)

export const boards = pgTable(
  "boards",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    publicId: text("public_id").notNull(),
    name: text("name").notNull(),
    ownerUserId: bigint("owner_user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    joinCodeHash: text("join_code_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("boards_public_id_unique").on(table.publicId),
    index("boards_owner_user_id_idx").on(table.ownerUserId),
    index("boards_join_code_hash_idx").on(table.joinCodeHash),
    index("boards_name_idx").on(table.name),
    check(
      "boards_public_id_format_check",
      sql`${table.publicId} ~ '^[A-Za-z0-9_-]{22}$'`,
    ),
    check(
      "boards_name_format_check",
      sql`${table.name} = btrim(${table.name}) AND ${table.name} <> '' AND char_length(${table.name}) <= 80 AND position(chr(10) in ${table.name}) = 0 AND position(chr(13) in ${table.name}) = 0 AND position(chr(8232) in ${table.name}) = 0 AND position(chr(8233) in ${table.name}) = 0`,
    ),
    check(
      "boards_join_code_hash_format_check",
      sql`${table.joinCodeHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
)

export const memberships = pgTable(
  "memberships",
  {
    boardId: bigint("board_id", { mode: "number" })
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.boardId, table.userId], name: "memberships_pkey" }),
    index("memberships_user_id_idx").on(table.userId),
    check("memberships_role_check", sql`${table.role} IN ('owner', 'member')`),
    uniqueIndex("memberships_one_owner_per_board").on(table.boardId).where(
      sql`${table.role} = 'owner'`,
    ),
  ],
)
