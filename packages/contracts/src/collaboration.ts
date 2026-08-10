import { z } from "zod"

import { usernameSchema } from "./auth.ts"
import { boardSummarySchema } from "./boards.ts"
import {
  boardCommandErrorSchema,
  stickyNoteCreatedSchema,
  stickyNoteCreationClaimGrantedSchema,
  type StickyNote,
} from "./sticky-notes.ts"

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
  stickyNotes: z.array(stickyNoteCreatedSchema.shape.stickyNote).optional(),
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
  const seenNotes = new Set<string>()
  for (const [index, note] of (snapshot.stickyNotes ?? []).entries()) {
    if (seenNotes.has(note.id)) {
      context.addIssue({
        code: "custom",
        path: ["stickyNotes", index, "id"],
        message: "Each Sticky Note must appear only once in an authoritative snapshot.",
      })
      continue
    }
    seenNotes.add(note.id)
  }
})

export const boardSocketMessageSchema = z.discriminatedUnion("type", [
  boardSnapshotSchema,
  stickyNoteCreationClaimGrantedSchema,
  stickyNoteCreatedSchema,
  boardCommandErrorSchema,
])

export const boardOpenReadyResponseSchema = z.object({
  status: z.literal("ready"),
})

export type PresenceActivity = z.infer<typeof presenceActivitySchema>
export type BoardPresence = z.infer<typeof boardPresenceSchema>
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>
export type BoardSocketMessage = z.infer<typeof boardSocketMessageSchema>
export type BoardOpenReadyResponse = z.infer<typeof boardOpenReadyResponseSchema>

export type BoardSnapshotStickyNote = StickyNote
