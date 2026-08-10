import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  index,
  pgTable,
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
