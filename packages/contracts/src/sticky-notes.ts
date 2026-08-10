import { z } from "zod"

import {
  countUserPerceivedCharacters,
  usernameSchema,
} from "./auth.ts"
import { boardIdentifierSchema } from "./boards.ts"

export const STICKY_NOTE_WIDTH = 32
export const MAX_STICKY_NOTE_CHARACTERS = 2_000
export const MAX_STICKY_NOTES = 500

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
  if (!value.isWellFormed()) {
    context.addIssue({
      code: "custom",
      message: "Sticky Note text must be well-formed Unicode.",
    })
  }
  if (countUserPerceivedCharacters(value) > MAX_STICKY_NOTE_CHARACTERS) {
    context.addIssue({
      code: "custom",
      message: `Use at most ${MAX_STICKY_NOTE_CHARACTERS} user-perceived Unicode characters.`,
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

export const boardCommandSchema = z.discriminatedUnion("type", [
  beginStickyNoteSchema,
  publishStickyNoteSchema,
  releaseStickyNoteCreationSchema,
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

export const boardCommandErrorCodeSchema = z.enum([
  "invalid_command",
  "creation_claim_unavailable",
  "invalid_creation_claim",
  "empty_sticky_note",
  "sticky_note_capacity",
  "sticky_note_rejected",
  "revision_conflict",
])

export const boardCommandErrorSchema = z.object({
  type: z.literal("error"),
  code: boardCommandErrorCodeSchema,
  error: z.string().min(1).max(200),
})

export type StickyNoteColor = z.infer<typeof stickyNoteColorSchema>
export type StickyNotePosition = z.infer<typeof stickyNotePositionSchema>
export type StickyNote = z.infer<typeof stickyNoteSchema>
export type BoardCommand = z.infer<typeof boardCommandSchema>
export type BeginStickyNote = z.infer<typeof beginStickyNoteSchema>
export type PublishStickyNote = z.infer<typeof publishStickyNoteSchema>
export type ReleaseStickyNoteCreation = z.infer<typeof releaseStickyNoteCreationSchema>
export type StickyNoteCreationClaimGranted = z.infer<typeof stickyNoteCreationClaimGrantedSchema>
export type StickyNoteCreated = z.infer<typeof stickyNoteCreatedSchema>
export type BoardCommandError = z.infer<typeof boardCommandErrorSchema>
