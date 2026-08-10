import { z } from "zod"

import { usernameSchema } from "./auth.ts"
import { boardSummarySchema } from "./boards.ts"

export const presenceActivitySchema = z.enum([
  "viewing",
  "creating",
  "editing",
  "moving",
])

export const boardPresenceSchema = z.object({
  member: z.object({ username: usernameSchema }),
  activity: presenceActivitySchema,
})

export const boardSnapshotSchema = z.object({
  type: z.literal("snapshot"),
  board: boardSummarySchema,
  revision: z.number().int().nonnegative(),
  presence: z.array(boardPresenceSchema),
}).superRefine((snapshot, context) => {
  const seenMembers = new Set<string>()
  for (const [index, presence] of snapshot.presence.entries()) {
    const username = presence.member.username
    if (seenMembers.has(username)) {
      context.addIssue({
        code: "custom",
        path: ["presence", index, "member", "username"],
        message: "Each connected Member must appear only once in Presence.",
      })
      continue
    }
    seenMembers.add(username)
  }
})

export const boardSocketMessageSchema = z.discriminatedUnion("type", [
  boardSnapshotSchema,
])

export const boardOpenReadyResponseSchema = z.object({
  status: z.literal("ready"),
})

export type PresenceActivity = z.infer<typeof presenceActivitySchema>
export type BoardPresence = z.infer<typeof boardPresenceSchema>
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>
export type BoardSocketMessage = z.infer<typeof boardSocketMessageSchema>
export type BoardOpenReadyResponse = z.infer<typeof boardOpenReadyResponseSchema>
