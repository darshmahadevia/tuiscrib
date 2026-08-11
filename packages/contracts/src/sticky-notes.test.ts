import { expect, test } from "bun:test"

import {
  beginStickyNoteEditSchema,
  boardCommandSchema,
  DEFAULT_STICKY_NOTE_COLOR,
  MAX_STICKY_NOTE_CHARACTERS,
  publishStickyNoteEditSchema,
  releaseStickyNoteEditSchema,
  stickyNoteSchema,
} from "./sticky-notes.ts"
import { boardSocketMessageSchema } from "./collaboration.ts"

const note = {
  id: "Qx7u3nW8kM2pR5sT9vY4aB",
  text: "First idea",
  textVersion: 1,
  position: { x: 4, y: -2 },
  color: DEFAULT_STICKY_NOTE_COLOR,
  stackingOrder: 0,
  authorship: { member: { username: "ada_lovelace" } },
  createdAt: "2026-08-10T00:00:00.000Z",
  lastEdit: {
    member: { username: "ada_lovelace" },
    at: "2026-08-10T00:00:00.000Z",
  },
}

test("accepts durable Sticky Note metadata without giving Color workflow meaning", () => {
  expect(stickyNoteSchema.parse(note)).toEqual(note)
})

test("rejects invalid Sticky Note bounds and missing durable attribution", () => {
  expect(() => stickyNoteSchema.parse({
    ...note,
    text: "🙂".repeat(MAX_STICKY_NOTE_CHARACTERS + 1),
  })).toThrow("user-perceived")

  expect(() => stickyNoteSchema.parse({
    ...note,
    lastEdit: undefined,
  })).toThrow()
})

test("requires creation authority before a non-empty Sticky Note publication", () => {
  const command = {
    type: "publish_sticky_note" as const,
    claimId: "5ab7d4c2-2a35-4ee3-9f0f-9d0d2a92f36a",
    provisionalId: "71ed2c45-67be-4a55-a5ae-90aafc1ecb1c",
    text: "durable text",
  }

  expect(boardCommandSchema.parse(command)).toEqual(command)
  expect(() => boardCommandSchema.parse({
    type: "publish_sticky_note",
    provisionalId: command.provisionalId,
    text: "durable text",
  })).toThrow()
})

test("accepts the authenticated Board heartbeat command", () => {
  expect(boardCommandSchema.parse({ type: "heartbeat" })).toEqual({ type: "heartbeat" })
})

test("validates the claim acknowledgement and revisioned creation event at the public socket seam", () => {
  expect(boardSocketMessageSchema.parse({
    type: "sticky_note_creation_claim_granted",
    provisionalId: "71ed2c45-67be-4a55-a5ae-90aafc1ecb1c",
    claimId: "5ab7d4c2-2a35-4ee3-9f0f-9d0d2a92f36a",
    position: { x: 0, y: 0 },
    color: DEFAULT_STICKY_NOTE_COLOR,
  })).toMatchObject({ type: "sticky_note_creation_claim_granted" })

  expect(boardSocketMessageSchema.parse({
    type: "sticky_note_created",
    revision: 1,
    provisionalId: "71ed2c45-67be-4a55-a5ae-90aafc1ecb1c",
    stickyNote: note,
  })).toMatchObject({ type: "sticky_note_created", revision: 1 })
})

test("models established Edit Claim publication as a full-text expected-version compare-and-set", () => {
  const claimId = "5ab7d4c2-2a35-4ee3-9f0f-9d0d2a92f36a"
  const stickyNoteId = note.id

  expect(boardCommandSchema.parse(beginStickyNoteEditSchema.parse({
    type: "begin_sticky_note_edit",
    stickyNoteId,
  }))).toEqual({
    type: "begin_sticky_note_edit",
    stickyNoteId,
  })

  expect(boardCommandSchema.parse(publishStickyNoteEditSchema.parse({
    type: "publish_sticky_note_edit",
    claimId,
    stickyNoteId,
    text: "",
    expectedTextVersion: 1,
  }))).toEqual({
    type: "publish_sticky_note_edit",
    claimId,
    stickyNoteId,
    text: "",
    expectedTextVersion: 1,
  })

  expect(boardCommandSchema.parse(releaseStickyNoteEditSchema.parse({
    type: "release_sticky_note_edit",
    claimId,
    stickyNoteId,
  }))).toEqual({
    type: "release_sticky_note_edit",
    claimId,
    stickyNoteId,
  })

  expect(() => publishStickyNoteEditSchema.parse({
    type: "publish_sticky_note_edit",
    claimId,
    stickyNoteId,
    text: "stale",
    expectedTextVersion: 0,
  })).toThrow()
})

test("recognizes an established Edit Claim acknowledgement and committed text update", () => {
  const claimId = "5ab7d4c2-2a35-4ee3-9f0f-9d0d2a92f36a"

  expect(boardSocketMessageSchema.parse({
    type: "sticky_note_edit_claim_granted",
    stickyNoteId: note.id,
    claimId,
    stickyNote: note,
  })).toMatchObject({
    type: "sticky_note_edit_claim_granted",
    stickyNoteId: note.id,
    claimId,
    stickyNote: { textVersion: 1 },
  })

  expect(boardSocketMessageSchema.parse({
    type: "sticky_note_updated",
    revision: 2,
    stickyNote: { ...note, text: "" , textVersion: 2 },
  })).toMatchObject({
    type: "sticky_note_updated",
    revision: 2,
    stickyNote: { text: "", textVersion: 2 },
  })
})
