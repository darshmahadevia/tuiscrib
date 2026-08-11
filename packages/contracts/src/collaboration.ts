import { z } from "zod"

import { usernameSchema } from "./auth.ts"
import { boardSummarySchema } from "./boards.ts"
import {
  boardCommandErrorSchema,
  boardEditClaimSchema,
  type BoardEditClaim,
  stickyNoteCreatedSchema,
  stickyNoteCreationClaimGrantedSchema,
  stickyNoteDeletedSchema,
  stickyNoteEditClaimGrantedSchema,
  stickyNoteMovedSchema,
  stickyNoteRecoloredSchema,
  stickyNoteReorderedSchema,
  stickyNoteUpdatedSchema,
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
  editClaims: z.array(boardEditClaimSchema).optional(),
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
  const seenStackingOrders = new Set<number>()
  const stackingOrders = (snapshot.stickyNotes ?? [])
    .map((note) => note.stackingOrder)
    .sort((left, right) => left - right)
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
    if (seenStackingOrders.has(note.stackingOrder)) {
      context.addIssue({
        code: "custom",
        path: ["stickyNotes", index, "stackingOrder"],
        message: "Each Sticky Note must have a unique Stacking Order within its Board.",
      })
    }
    seenStackingOrders.add(note.stackingOrder)
  }
  for (const [index, stackingOrder] of stackingOrders.entries()) {
    if (stackingOrder !== index) {
      context.addIssue({
        code: "custom",
        path: ["stickyNotes"],
        message: "Board Stacking Order must be the contiguous back-to-front sequence starting at zero.",
      })
      break
    }
  }
  const seenClaims = new Set<string>()
  for (const [index, claim] of (snapshot.editClaims ?? []).entries()) {
    if (seenClaims.has(claim.stickyNoteId)) {
      context.addIssue({
        code: "custom",
        path: ["editClaims", index, "stickyNoteId"],
        message: "Each Sticky Note may have only one authoritative Edit Claim.",
      })
      continue
    }
    seenClaims.add(claim.stickyNoteId)
  }
})

export const boardAuthorizationLossReasonSchema = z.enum([
  "board_deleted",
])

export const boardAuthorizationLostSchema = z.object({
  type: z.literal("board_authorization_lost"),
  reason: boardAuthorizationLossReasonSchema,
}).strict()

export const boardSocketMessageSchema = z.discriminatedUnion("type", [
  boardSnapshotSchema,
  boardAuthorizationLostSchema,
  stickyNoteCreationClaimGrantedSchema,
  stickyNoteCreatedSchema,
  stickyNoteEditClaimGrantedSchema,
  stickyNoteMovedSchema,
  stickyNoteRecoloredSchema,
  stickyNoteReorderedSchema,
  stickyNoteDeletedSchema,
  stickyNoteUpdatedSchema,
  boardCommandErrorSchema,
])

export const boardOpenReadyResponseSchema = z.object({
  status: z.literal("ready"),
})

export type PresenceActivity = z.infer<typeof presenceActivitySchema>
export type BoardPresence = z.infer<typeof boardPresenceSchema>
export type { BoardEditClaim }
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>
export type BoardAuthorizationLossReason = z.infer<typeof boardAuthorizationLossReasonSchema>
export type BoardAuthorizationLost = z.infer<typeof boardAuthorizationLostSchema>
export type BoardSocketMessage = z.infer<typeof boardSocketMessageSchema>
export type BoardOpenReadyResponse = z.infer<typeof boardOpenReadyResponseSchema>

export type BoardSnapshotStickyNote = StickyNote
