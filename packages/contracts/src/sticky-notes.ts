import { z } from "zod"

import {
  countUserPerceivedCharacters,
  USER_PERCEIVED_CHARACTER_SEGMENTATION_UNAVAILABLE,
  usernameSchema,
} from "./auth.ts"
import { boardIdentifierSchema } from "./boards.ts"

export const STICKY_NOTE_WIDTH = 32
export const MAX_STICKY_NOTE_CHARACTERS = 2_000
export const MAX_STICKY_NOTES = 500
export const STICKY_NOTE_TEXT_LIMIT_ERROR =
  "Use at most 2,000 user-perceived Unicode characters."

export const stickyNoteColorSchema = z.enum([
  "amber",
  "blue",
  "cyan",
  "green",
  "magenta",
  "red",
  "violet",
  "yellow",
])

export const DEFAULT_STICKY_NOTE_COLOR = "yellow" as const

const coordinateSchema = z.number().int().min(-1_000_000).max(1_000_000)

export const stickyNotePositionSchema = z.object({
  x: coordinateSchema,
  y: coordinateSchema,
})

export const stickyNoteTextSchema = z.string().superRefine((value, context) => {
  let wellFormed: boolean
  try {
    wellFormed = value.isWellFormed()
  } catch {
    context.addIssue({
      code: "custom",
      message: USER_PERCEIVED_CHARACTER_SEGMENTATION_UNAVAILABLE,
    })
    return
  }
  if (!wellFormed) {
    context.addIssue({
      code: "custom",
      message: "Sticky Note text must be well-formed Unicode.",
    })
  }
  let characterCount: number
  try {
    characterCount = countUserPerceivedCharacters(value)
  } catch {
    context.addIssue({
      code: "custom",
      message: USER_PERCEIVED_CHARACTER_SEGMENTATION_UNAVAILABLE,
    })
    return
  }
  if (characterCount > MAX_STICKY_NOTE_CHARACTERS) {
    context.addIssue({
      code: "custom",
      message: STICKY_NOTE_TEXT_LIMIT_ERROR,
    })
  }
  if (value.includes("\u0000")) {
    context.addIssue({
      code: "custom",
      message: "Sticky Note text cannot contain a null character.",
    })
  }
})

const noteMemberSchema = z.object({ username: usernameSchema })
const isoTimestampSchema = z.iso.datetime()

export const stickyNoteAuthorshipSchema = z.object({
  member: noteMemberSchema,
})

export const stickyNoteLastEditSchema = z.object({
  member: noteMemberSchema,
  at: isoTimestampSchema,
})

export const stickyNoteSchema = z.object({
  id: boardIdentifierSchema,
  text: stickyNoteTextSchema,
  textVersion: z.number().int().positive(),
  position: stickyNotePositionSchema,
  color: stickyNoteColorSchema,
  stackingOrder: z.number().int().nonnegative(),
  authorship: stickyNoteAuthorshipSchema,
  createdAt: isoTimestampSchema,
  lastEdit: stickyNoteLastEditSchema,
})

export function compareStickyNoteStackingOrder(
  left: Pick<z.infer<typeof stickyNoteSchema>, "id" | "stackingOrder">,
  right: Pick<z.infer<typeof stickyNoteSchema>, "id" | "stackingOrder">,
): number {
  if (left.stackingOrder !== right.stackingOrder) {
    return left.stackingOrder - right.stackingOrder
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

export const provisionalStickyNoteIdSchema = z.string().uuid()
export const stickyNoteClaimIdSchema = z.string().uuid()

export const beginStickyNoteSchema = z.object({
  type: z.literal("begin_sticky_note"),
  provisionalId: provisionalStickyNoteIdSchema,
  position: stickyNotePositionSchema,
  color: stickyNoteColorSchema,
})

export const publishStickyNoteSchema = z.object({
  type: z.literal("publish_sticky_note"),
  claimId: stickyNoteClaimIdSchema,
  provisionalId: provisionalStickyNoteIdSchema,
  text: stickyNoteTextSchema,
})

export const releaseStickyNoteCreationSchema = z.object({
  type: z.literal("release_sticky_note_creation"),
  claimId: stickyNoteClaimIdSchema,
  provisionalId: provisionalStickyNoteIdSchema,
})

export const beginStickyNoteEditSchema = z.object({
  type: z.literal("begin_sticky_note_edit"),
  stickyNoteId: boardIdentifierSchema,
})

export const publishStickyNoteEditSchema = z.object({
  type: z.literal("publish_sticky_note_edit"),
  claimId: stickyNoteClaimIdSchema,
  stickyNoteId: boardIdentifierSchema,
  text: stickyNoteTextSchema,
  expectedTextVersion: z.number().int().positive(),
})

export const releaseStickyNoteEditSchema = z.object({
  type: z.literal("release_sticky_note_edit"),
  claimId: stickyNoteClaimIdSchema,
  stickyNoteId: boardIdentifierSchema,
})

export const recolorStickyNoteSchema = z.object({
  type: z.literal("recolor_sticky_note"),
  stickyNoteId: boardIdentifierSchema,
  color: stickyNoteColorSchema,
})

export const stickyNoteStackingDirectionSchema = z.enum(["lower", "raise"])

export const reorderStickyNoteSchema = z.object({
  type: z.literal("reorder_sticky_note"),
  stickyNoteId: boardIdentifierSchema,
  direction: stickyNoteStackingDirectionSchema,
})

export const boardHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
})

export const boardCommandSchema = z.discriminatedUnion("type", [
  beginStickyNoteSchema,
  publishStickyNoteSchema,
  releaseStickyNoteCreationSchema,
  beginStickyNoteEditSchema,
  publishStickyNoteEditSchema,
  releaseStickyNoteEditSchema,
  recolorStickyNoteSchema,
  reorderStickyNoteSchema,
  boardHeartbeatSchema,
])

export const stickyNoteCreationClaimGrantedSchema = z.object({
  type: z.literal("sticky_note_creation_claim_granted"),
  provisionalId: provisionalStickyNoteIdSchema,
  claimId: stickyNoteClaimIdSchema,
  position: stickyNotePositionSchema,
  color: stickyNoteColorSchema,
})

export const stickyNoteCreatedSchema = z.object({
  type: z.literal("sticky_note_created"),
  revision: z.number().int().positive(),
  provisionalId: provisionalStickyNoteIdSchema.optional(),
  stickyNote: stickyNoteSchema,
})

export const stickyNoteEditClaimGrantedSchema = z.object({
  type: z.literal("sticky_note_edit_claim_granted"),
  stickyNoteId: boardIdentifierSchema,
  claimId: stickyNoteClaimIdSchema,
  stickyNote: stickyNoteSchema,
})

export const stickyNoteUpdatedSchema = z.object({
  type: z.literal("sticky_note_updated"),
  revision: z.number().int().positive(),
  stickyNote: stickyNoteSchema,
})

export const stickyNoteRecoloredSchema = z.object({
  type: z.literal("sticky_note_recolored"),
  revision: z.number().int().positive(),
  stickyNote: stickyNoteSchema,
})

export const stickyNoteReorderedSchema = z.object({
  type: z.literal("sticky_note_reordered"),
  revision: z.number().int().positive(),
  stickyNote: stickyNoteSchema,
  affectedStickyNotes: z.array(stickyNoteSchema).min(1).optional(),
})

export const editClaimConnectionSchema = z.enum(["connected", "disconnected"])

export const boardEditClaimSchema = z.object({
  stickyNoteId: boardIdentifierSchema,
  holder: noteMemberSchema,
  status: editClaimConnectionSchema,
  expiresAt: isoTimestampSchema.optional(),
})

export const boardCommandErrorCodeSchema = z.enum([
  "invalid_command",
  "creation_claim_unavailable",
  "invalid_creation_claim",
  "edit_claim_unavailable",
  "invalid_edit_claim",
  "empty_sticky_note",
  "sticky_note_text_limit",
  "sticky_note_capacity",
  "sticky_note_rejected",
  "text_version_conflict",
  "stacking_order_boundary",
  "revision_conflict",
])

export const boardCommandErrorSchema = z.object({
  type: z.literal("error"),
  code: boardCommandErrorCodeSchema,
  error: z.string().min(1).max(200),
  claimHolder: z.object({ username: usernameSchema }).optional(),
  claimConnection: editClaimConnectionSchema.optional(),
  claimExpiresAt: isoTimestampSchema.optional(),
  authoritative: z.object({
    revision: z.number().int().nonnegative(),
    stickyNote: stickyNoteSchema,
  }).optional(),
})

export type StickyNoteColor = z.infer<typeof stickyNoteColorSchema>
export type StickyNotePosition = z.infer<typeof stickyNotePositionSchema>
export type StickyNote = z.infer<typeof stickyNoteSchema>
export type BoardCommand = z.infer<typeof boardCommandSchema>
export type BeginStickyNote = z.infer<typeof beginStickyNoteSchema>
export type PublishStickyNote = z.infer<typeof publishStickyNoteSchema>
export type ReleaseStickyNoteCreation = z.infer<typeof releaseStickyNoteCreationSchema>
export type BeginStickyNoteEdit = z.infer<typeof beginStickyNoteEditSchema>
export type PublishStickyNoteEdit = z.infer<typeof publishStickyNoteEditSchema>
export type ReleaseStickyNoteEdit = z.infer<typeof releaseStickyNoteEditSchema>
export type RecolorStickyNote = z.infer<typeof recolorStickyNoteSchema>
export type StickyNoteStackingDirection = z.infer<typeof stickyNoteStackingDirectionSchema>
export type ReorderStickyNote = z.infer<typeof reorderStickyNoteSchema>
export type BoardHeartbeat = z.infer<typeof boardHeartbeatSchema>
export type StickyNoteCreationClaimGranted = z.infer<typeof stickyNoteCreationClaimGrantedSchema>
export type StickyNoteCreated = z.infer<typeof stickyNoteCreatedSchema>
export type StickyNoteEditClaimGranted = z.infer<typeof stickyNoteEditClaimGrantedSchema>
export type StickyNoteUpdated = z.infer<typeof stickyNoteUpdatedSchema>
export type StickyNoteRecolored = z.infer<typeof stickyNoteRecoloredSchema>
export type StickyNoteReordered = z.infer<typeof stickyNoteReorderedSchema>
export type BoardEditClaim = z.infer<typeof boardEditClaimSchema>
export type BoardCommandError = z.infer<typeof boardCommandErrorSchema>
