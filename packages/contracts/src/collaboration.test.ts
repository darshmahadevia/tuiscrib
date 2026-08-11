import { expect, test } from "bun:test"

import {
  boardOpenReadyResponseSchema,
  boardSocketMessageSchema,
} from "./collaboration.ts"

const board = {
  id: "Qx7u3nW8kM2pR5sT9vY4aB",
  name: "Ideas",
  role: "member" as const,
}

test("accepts a complete Board snapshot with a monotonic revision and one Presence per Member", () => {
  const snapshot = {
    type: "snapshot" as const,
    board,
    revision: 4,
    presence: [
      { member: { username: "ada_lovelace" }, activity: "viewing" as const },
      { member: { username: "grace_hopper" }, activity: "viewing" as const },
    ],
  }

  expect(boardSocketMessageSchema.parse(snapshot)).toEqual(snapshot)
})

test("rejects duplicate Member Presence in one authoritative snapshot", () => {
  expect(() => boardSocketMessageSchema.parse({
    type: "snapshot",
    board,
    revision: 0,
    presence: [
      { member: { username: "ada_lovelace" }, activity: "viewing" },
      { member: { username: "ada_lovelace" }, activity: "viewing" },
    ],
  })).toThrow("once")
})

test("projects disconnected Edit Claims without private connection identity", () => {
  const snapshot = {
    type: "snapshot" as const,
    board,
    revision: 4,
    presence: [{ member: { username: "grace_hopper" }, activity: "viewing" as const }],
    editClaims: [{
      stickyNoteId: "Lm7u3nW8kM2pR5sT9vY4aB",
      holder: { username: "ada_lovelace" },
      status: "disconnected" as const,
      expiresAt: "2026-08-10T00:00:30.000Z",
    }],
  }

  expect(boardSocketMessageSchema.parse(snapshot)).toEqual(snapshot)
  expect(() => boardSocketMessageSchema.parse({
    ...snapshot,
    editClaims: [...snapshot.editClaims, snapshot.editClaims[0]],
  })).toThrow("only one")
  expect(boardSocketMessageSchema.parse({
    type: "error",
    code: "edit_claim_unavailable",
    error: "Another Terminal Session already holds this Edit Claim.",
    claimHolder: { username: "ada_lovelace" },
    claimConnection: "disconnected",
    claimExpiresAt: "2026-08-10T00:00:30.000Z",
  })).toMatchObject({ claimConnection: "disconnected" })
})

test("recognizes the non-private Board collaboration preflight response", () => {
  expect(boardOpenReadyResponseSchema.parse({ status: "ready" })).toEqual({ status: "ready" })
})

test("keeps Edit Claim and text-version conflicts in the public Board command error vocabulary", () => {
  expect(boardSocketMessageSchema.parse({
    type: "error",
    code: "edit_claim_unavailable",
    error: "Another Terminal Session already holds this Edit Claim.",
  })).toMatchObject({ code: "edit_claim_unavailable" })

  expect(boardSocketMessageSchema.parse({
    type: "error",
    code: "text_version_conflict",
    error: "Sticky Note text changed before this publication.",
  })).toMatchObject({ code: "text_version_conflict" })
})
