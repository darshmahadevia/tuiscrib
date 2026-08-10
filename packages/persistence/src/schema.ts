import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const serviceMetadata = pgTable("service_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})
