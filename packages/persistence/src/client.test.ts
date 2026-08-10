import { afterAll, beforeAll, expect, test } from "bun:test"

import { MAX_STICKY_NOTES } from "@tuiscrib/contracts"

import { createPersistence, type Persistence } from "./client.ts"

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
const integrationTest = databaseUrl ? test : test.skip

let persistence: Persistence | null = null
let concurrentPersistence: Persistence | null = null

beforeAll(async () => {
  if (!databaseUrl) {
    return
  }
  persistence = createPersistence({ databaseUrl, maxConnections: 4 })
  concurrentPersistence = createPersistence({ databaseUrl, maxConnections: 4 })
  await persistence.migrate()
  await persistence.reset()
})

afterAll(async () => {
  await concurrentPersistence?.close()
  await persistence?.close()
})

integrationTest("creates a durable Sticky Note with attribution and one later Board revision", async () => {
  if (!persistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "ada_lovelace",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "a".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }

  const board = await persistence.createBoard({
    publicId: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Ideas",
    ownerUserId: registered.user.id,
    joinCodeHash: "b".repeat(64),
    now,
  })
  expect(board.kind).toBe("created")

  const created = await persistence.createStickyNote({
    publicId: "Lm7u3nW8kM2pR5sT9vY4aB",
    boardId: "Qx7u3nW8kM2pR5sT9vY4aB",
    userId: registered.user.id,
    text: "First idea",
    position: { x: 4, y: -2 },
    color: "yellow",
    now,
  })

  expect(created.kind).toBe("created")
  if (created.kind !== "created") {
    return
  }
  expect(created.revision).toBe(1)
  expect(created.stickyNote).toMatchObject({
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "First idea",
    textVersion: 1,
    position: { x: 4, y: -2 },
    color: "yellow",
    stackingOrder: 0,
    authorship: { member: { username: "ada_lovelace" } },
    createdAt: now.toISOString(),
    lastEdit: {
      member: { username: "ada_lovelace" },
      at: now.toISOString(),
    },
  })

  const opened = await persistence.openBoard({
    userId: registered.user.id,
    publicId: "Qx7u3nW8kM2pR5sT9vY4aB",
  })
  expect(opened?.revision).toBe(1)
  expect(opened?.stickyNotes).toHaveLength(1)
})

integrationTest("rejects empty creation without a durable row or a Board revision", async () => {
  if (!persistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "grace_hopper",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "c".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }
  await persistence.createBoard({
    publicId: "AbCdEfGhIjKlMnOpQrStUv",
    name: "Empty",
    ownerUserId: registered.user.id,
    joinCodeHash: "d".repeat(64),
    now,
  })

  await expect(persistence.createStickyNote({
    publicId: "BcDeFgHiJkLmNoPqRsTuVw",
    boardId: "AbCdEfGhIjKlMnOpQrStUv",
    userId: registered.user.id,
    text: "",
    position: { x: 0, y: 0 },
    color: "yellow",
    now,
  })).resolves.toEqual({ kind: "empty_text" })

  const opened = await persistence.openBoard({
    userId: registered.user.id,
    publicId: "AbCdEfGhIjKlMnOpQrStUv",
  })
  expect(opened?.revision).toBe(0)
  expect(opened?.stickyNotes).toEqual([])
})

integrationTest("serializes concurrent note creations by committed Board revision", async () => {
  if (!persistence || !concurrentPersistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "concurrent_creator",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "e".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }
  await persistence.createBoard({
    publicId: "CdeFgHiJkLmNoPqRsTuVwX",
    name: "Concurrent",
    ownerUserId: registered.user.id,
    joinCodeHash: "f".repeat(64),
    now,
  })

  const results = await Promise.all([
    persistence.createStickyNote({
      publicId: "DeFgHiJkLmNoPqRsTuVwXy",
      boardId: "CdeFgHiJkLmNoPqRsTuVwX",
      userId: registered.user.id,
      text: "one",
      position: { x: 0, y: 0 },
      color: "yellow",
      now,
    }),
    concurrentPersistence.createStickyNote({
      publicId: "EfGhIjKlMnOpQrStUvWxYz",
      boardId: "CdeFgHiJkLmNoPqRsTuVwX",
      userId: registered.user.id,
      text: "two",
      position: { x: 1, y: 1 },
      color: "blue",
      now,
    }),
  ])

  expect(results.map((result) => result.kind)).toEqual(["created", "created"])
  expect(results.map((result) => result.kind === "created" ? result.revision : 0).sort()).toEqual([1, 2])
})

integrationTest("enforces the Sticky Note text limit by user-perceived Unicode characters", async () => {
  if (!persistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "grapheme_creator",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "g".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }
  const boardId = "GdeFgHiJkLmNoPqRsTuVwX"
  await persistence.createBoard({
    publicId: boardId,
    name: "Graphemes",
    ownerUserId: registered.user.id,
    joinCodeHash: "8".repeat(64),
    now,
  })

  const exactlyAtLimit = "e\u0301".repeat(2_000)
  const created = await persistence.createStickyNote({
    publicId: "HdeFgHiJkLmNoPqRsTuVwX",
    boardId,
    userId: registered.user.id,
    text: exactlyAtLimit,
    position: { x: 0, y: 0 },
    color: "yellow",
    now,
  })
  expect(created.kind).toBe("created")

  await expect(persistence.createStickyNote({
    publicId: "IdeFgHiJkLmNoPqRsTuVwX",
    boardId,
    userId: registered.user.id,
    text: `${exactlyAtLimit}e\u0301`,
    position: { x: 1, y: 1 },
    color: "blue",
    now,
  })).resolves.toEqual({ kind: "invalid_text" })
})

integrationTest("accepts only one competing final-slot creation and preserves existing notes on rejection", async () => {
  if (!persistence || !concurrentPersistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "capacity_creator",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "j".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }
  const boardId = "JdeFgHiJkLmNoPqRsTuVwX"
  await persistence.createBoard({
    publicId: boardId,
    name: "Capacity",
    ownerUserId: registered.user.id,
    joinCodeHash: "9".repeat(64),
    now,
  })

  for (let index = 0; index < MAX_STICKY_NOTES - 1; index += 1) {
    const created = await persistence.createStickyNote({
      publicId: capacityNoteId(index),
      boardId,
      userId: registered.user.id,
      text: `existing ${index}`,
      position: { x: index, y: 0 },
      color: index % 2 === 0 ? "yellow" : "blue",
      now,
    })
    expect(created.kind).toBe("created")
  }

  await expect(persistence.createStickyNote({
    publicId: capacityNoteId(0),
    boardId,
    userId: registered.user.id,
    text: "duplicate public id must roll back",
    position: { x: 9, y: 9 },
    color: "violet",
    now,
  })).rejects.toThrow()

  const afterRollback = await persistence.openBoard({ userId: registered.user.id, publicId: boardId })
  expect(afterRollback?.revision).toBe(MAX_STICKY_NOTES - 1)
  expect(afterRollback?.stickyNotes).toHaveLength(MAX_STICKY_NOTES - 1)

  const results = await Promise.all([
    persistence.createStickyNote({
      publicId: capacityNoteId(MAX_STICKY_NOTES - 1),
      boardId,
      userId: registered.user.id,
      text: "first final-slot attempt",
      position: { x: 499, y: 0 },
      color: "green",
      now,
    }),
    concurrentPersistence.createStickyNote({
      publicId: capacityNoteId(MAX_STICKY_NOTES),
      boardId,
      userId: registered.user.id,
      text: "second final-slot attempt",
      position: { x: 500, y: 0 },
      color: "red",
      now,
    }),
  ])

  expect(results.map((result) => result.kind).sort()).toEqual(["board_capacity", "created"])

  const opened = await persistence.openBoard({ userId: registered.user.id, publicId: boardId })
  expect(opened?.revision).toBe(MAX_STICKY_NOTES)
  expect(opened?.stickyNotes).toHaveLength(MAX_STICKY_NOTES)
  expect(opened?.stickyNotes?.some((note) => note.text === "first final-slot attempt" || note.text === "second final-slot attempt")).toBe(true)
  expect(opened?.stickyNotes?.some((note) => note.text === "existing 0")).toBe(true)
  expect(opened?.stickyNotes?.some((note) => note.text === "existing 498")).toBe(true)
})

function capacityNoteId(index: number): string {
  return `N${index.toString().padStart(21, "0")}`
}
