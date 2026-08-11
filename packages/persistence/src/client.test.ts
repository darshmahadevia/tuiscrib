import { afterAll, beforeAll, expect, test } from "bun:test"

import { MAX_STICKY_NOTES } from "@tuiscrib/contracts"
import postgres from "postgres"

import {
  createPersistence,
  MIGRATION_LOCK_NAME,
  type Persistence,
} from "./client.ts"

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL ?? databaseUrl
const integrationTest = databaseUrl ? test : test.skip

let persistence: Persistence | null = null
let concurrentPersistence: Persistence | null = null
let migrationPersistence: Persistence | null = null

test("keeps the persistence pool within the migration-safe bounded range", () => {
  const options = { databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/tuiscrib" }

  expect(() => createPersistence({ ...options, maxConnections: 1 })).toThrow("2 through 8")
  expect(() => createPersistence({ ...options, maxConnections: 9 })).toThrow("2 through 8")
})

beforeAll(async () => {
  if (!databaseUrl) {
    return
  }
  persistence = createPersistence({
    databaseUrl,
    applicationName: "tuiscrib-test-primary",
    maxConnections: 4,
  })
  concurrentPersistence = createPersistence({
    databaseUrl,
    applicationName: "tuiscrib-test-concurrent",
    maxConnections: 4,
  })
  if (migrationDatabaseUrl) {
    migrationPersistence = createPersistence({
      databaseUrl: migrationDatabaseUrl,
      applicationName: "tuiscrib-test-migration",
      maxConnections: 4,
    })
    await migrationPersistence.migrate()
  }
  await persistence.reset()
})

afterAll(async () => {
  await concurrentPersistence?.close()
  await persistence?.close()
  await migrationPersistence?.close()
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

integrationTest("deletes a Board graph only for its Owner and repairs the owned-Board count", async () => {
  if (!persistence || !databaseUrl) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const owner = await persistence.registerUser({
    username: "board_delete_owner",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "board-delete-owner".padEnd(64, "a"),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  const member = await persistence.registerUser({
    username: "board_delete_member",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "board-delete-member".padEnd(64, "b"),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!owner || !member) {
    throw new Error("users were not registered")
  }

  const boardId = "board24-delete-graph-0"
  const joinCodeHash = "c".repeat(64)
  await expect(persistence.createBoard({
    publicId: boardId,
    name: "Delete Graph",
    ownerUserId: owner.user.id,
    joinCodeHash,
    now,
  })).resolves.toMatchObject({ kind: "created" })
  await expect(persistence.joinBoard({
    userId: member.user.id,
    joinCodeHash,
    now,
  })).resolves.toMatchObject({ kind: "joined" })
  await expect(persistence.createStickyNote({
    publicId: "board24-delete-note-01",
    boardId,
    userId: member.user.id,
    text: "must cascade",
    position: { x: 1, y: 2 },
    color: "yellow",
    now,
  })).resolves.toMatchObject({ kind: "created" })

  await expect(persistence.deleteBoard({
    userId: member.user.id,
    publicId: boardId,
  })).resolves.toEqual({ kind: "not_owner" })
  await expect(persistence.openBoard({ userId: owner.user.id, publicId: boardId })).resolves.toMatchObject({
    board: { id: boardId, name: "Delete Graph" },
    stickyNotes: [{ id: "board24-delete-note-01" }],
  })

  await expect(persistence.deleteBoard({
    userId: owner.user.id,
    publicId: boardId,
  })).resolves.toEqual({ kind: "deleted" })
  await expect(persistence.openBoard({ userId: owner.user.id, publicId: boardId })).resolves.toBeNull()
  await expect(persistence.openBoard({ userId: member.user.id, publicId: boardId })).resolves.toBeNull()
  await expect(persistence.listBoards({ userId: owner.user.id, nameFilter: "" })).resolves.toEqual([])
  await expect(persistence.listBoards({ userId: member.user.id, nameFilter: "" })).resolves.toEqual([])
  await expect(persistence.joinBoard({ userId: member.user.id, joinCodeHash, now })).resolves.toEqual({
    kind: "invalid_join_code",
  })

  const inspector = postgres(databaseUrl, { max: 1, prepare: false })
  try {
    const ownerCount = await inspector`
      select owned_board_count
      from users
      where id = ${owner.user.id}
    `
    expect(ownerCount[0]?.owned_board_count).toBe(0)
    const childRows = await inspector`
      select
        (select count(*)::int from memberships m join boards b on b.id = m.board_id where b.public_id = ${boardId}) as memberships,
        (select count(*)::int from sticky_notes n join boards b on b.id = n.board_id where b.public_id = ${boardId}) as sticky_notes
    `
    expect(childRows[0]).toEqual({ memberships: 0, sticky_notes: 0 })
  } finally {
    await inspector.end({ timeout: 5 })
  }
})

integrationTest("rolls back the complete Board deletion graph when post-delete bookkeeping fails", async () => {
  if (!persistence || !databaseUrl) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "board_delete_rollback",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "board-delete-rollback".padEnd(64, "d"),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }

  const boardId = "board24-delete-rolledx"
  const noteId = "board24-delete-note-rb"
  await persistence.createBoard({
    publicId: boardId,
    name: "Delete Rollback",
    ownerUserId: registered.user.id,
    joinCodeHash: "e".repeat(64),
    now,
  })
  await persistence.createStickyNote({
    publicId: noteId,
    boardId,
    userId: registered.user.id,
    text: "survives every failed step",
    position: { x: 0, y: 0 },
    color: "blue",
    now,
  })

  const triggerClient = postgres(databaseUrl, { max: 1, prepare: false })
  try {
    await triggerClient.unsafe(`
      create or replace function tuiscrib_board24_delete_rollback() returns trigger
      language plpgsql as $$
      begin
        if new.id = ${registered.user.id} and new.owned_board_count = 0 then
          raise exception 'board24 deletion rollback sentinel';
        end if;
        return new;
      end;
      $$;
      create trigger tuiscrib_board24_delete_rollback_trigger
      before update of owned_board_count on users
      for each row execute function tuiscrib_board24_delete_rollback();
    `)

    await expect(persistence.deleteBoard({
      userId: registered.user.id,
      publicId: boardId,
    })).rejects.toThrow("Failed query: update")
    await expect(persistence.openBoard({
      userId: registered.user.id,
      publicId: boardId,
    })).resolves.toMatchObject({
      board: { id: boardId, name: "Delete Rollback" },
      revision: 1,
      stickyNotes: [{ id: noteId, text: "survives every failed step" }],
    })
  } finally {
    await triggerClient.unsafe(`
      drop trigger if exists tuiscrib_board24_delete_rollback_trigger on users;
      drop function if exists tuiscrib_board24_delete_rollback();
    `).catch(() => undefined)
    await triggerClient.end({ timeout: 5 })
  }

  await expect(persistence.deleteBoard({
    userId: registered.user.id,
    publicId: boardId,
  })).resolves.toEqual({ kind: "deleted" })
})

integrationTest("serializes competing Board deletions by the PostgreSQL Board lock", async () => {
  if (!persistence || !concurrentPersistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "board_delete_racer",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "board-delete-racer".padEnd(64, "f"),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }

  const boardId = "board24-delete-race-01"
  await persistence.createBoard({
    publicId: boardId,
    name: "Delete Race",
    ownerUserId: registered.user.id,
    joinCodeHash: "a".repeat(64),
    now,
  })

  const results = await Promise.all([
    persistence.deleteBoard({ userId: registered.user.id, publicId: boardId }),
    concurrentPersistence.deleteBoard({ userId: registered.user.id, publicId: boardId }),
  ])
  expect(results.map((result) => result.kind).sort()).toEqual(["deleted", "not_found"])
})

integrationTest("keeps Board cascade foreign keys and child access paths indexed", async () => {
  if (!databaseUrl) {
    throw new Error("database URL was not configured")
  }

  const inspector = postgres(databaseUrl, { max: 1, prepare: false })
  try {
    const constraints = await inspector`
      select conrelid::regclass::text as table_name, conname, confdeltype
      from pg_constraint
      where conname in ('memberships_board_id_boards_id_fk', 'sticky_notes_board_id_boards_id_fk')
      order by conname
    `
    expect([...constraints]).toEqual([
      { table_name: "memberships", conname: "memberships_board_id_boards_id_fk", confdeltype: "c" },
      { table_name: "sticky_notes", conname: "sticky_notes_board_id_boards_id_fk", confdeltype: "c" },
    ])

    const indexes = await inspector`
      select indexname
      from pg_indexes
      where indexname in ('memberships_pkey', 'sticky_notes_board_id_idx')
      order by indexname
    `
    expect([...indexes]).toEqual([
      { indexname: "memberships_pkey" },
      { indexname: "sticky_notes_board_id_idx" },
    ])
  } finally {
    await inspector.end({ timeout: 5 })
  }
})

integrationTest("serializes concurrent Stacking Order changes in PostgreSQL commit order", async () => {
  if (!persistence || !concurrentPersistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "order_writer",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "o".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }

  const boardId = "OdeFgHiJkLmNoPqRsTuVwX"
  await persistence.createBoard({
    publicId: boardId,
    name: "Stacking Order",
    ownerUserId: registered.user.id,
    joinCodeHash: "f".repeat(64),
    now,
  })
  const noteIds = [
    "PdeFgHiJkLmNoPqRsTuVwX",
    "QdeFgHiJkLmNoPqRsTuVwX",
    "RdeFgHiJkLmNoPqRsTuVwX",
  ]
  for (const [index, noteId] of noteIds.entries()) {
    await persistence.createStickyNote({
      publicId: noteId,
      boardId,
      userId: registered.user.id,
      text: `overlap ${index}`,
      position: { x: 0, y: 0 },
      color: index === 0 ? "yellow" : index === 1 ? "blue" : "green",
      now,
    })
  }

  const first = await persistence.reorderStickyNote({
    boardId,
    stickyNoteId: noteIds[0]!,
    userId: registered.user.id,
    direction: "raise",
  })
  expect(first).toMatchObject({
    kind: "reordered",
    revision: 4,
    stickyNote: { stackingOrder: 1 },
    affectedStickyNotes: [
      { id: noteIds[1], stackingOrder: 0 },
      { id: noteIds[0], stackingOrder: 1 },
    ],
  })

  const concurrent = await Promise.all([
    persistence.reorderStickyNote({
      boardId,
      stickyNoteId: noteIds[0]!,
      userId: registered.user.id,
      direction: "raise",
    }),
    concurrentPersistence.reorderStickyNote({
      boardId,
      stickyNoteId: noteIds[2]!,
      userId: registered.user.id,
      direction: "lower",
    }),
  ])
  expect(concurrent.map((result) => result.kind)).toEqual(["reordered", "reordered"])
  expect(concurrent.map((result) => result.kind === "reordered" ? result.revision : 0).sort()).toEqual([5, 6])

  const opened = await persistence.openBoard({ userId: registered.user.id, publicId: boardId })
  expect(opened?.revision).toBe(6)
  expect(opened?.stickyNotes?.map((note) => note.stackingOrder)).toEqual([0, 1, 2])
  expect(new Set(opened?.stickyNotes?.map((note) => note.id))).toEqual(new Set(noteIds))
})

integrationTest("serializes concurrent Position changes by Board revision in PostgreSQL commit order", async () => {
  if (!persistence || !concurrentPersistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "movement_writer",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "d".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }

  const boardId = "SdeFgHiJkLmNoPqRsTuVwX"
  const noteId = "TdeFgHiJkLmNoPqRsTuVwX"
  await persistence.createBoard({
    publicId: boardId,
    name: "Movement",
    ownerUserId: registered.user.id,
    joinCodeHash: "7".repeat(64),
    now,
  })
  await persistence.createStickyNote({
    publicId: noteId,
    boardId,
    userId: registered.user.id,
    text: "move me",
    position: { x: 0, y: 0 },
    color: "yellow",
    now,
  })

  const concurrent = await Promise.all([
    persistence.moveStickyNote({
      boardId,
      stickyNoteId: noteId,
      userId: registered.user.id,
      direction: "right",
    }),
    concurrentPersistence.moveStickyNote({
      boardId,
      stickyNoteId: noteId,
      userId: registered.user.id,
      direction: "up",
    }),
  ])
  expect(concurrent.map((result) => result.kind)).toEqual(["moved", "moved"])
  expect(concurrent.map((result) => result.kind === "moved" ? result.revision : 0).sort()).toEqual([2, 3])

  const opened = await persistence.openBoard({ userId: registered.user.id, publicId: boardId })
  expect(opened?.revision).toBe(3)
  expect(opened?.stickyNotes).toMatchObject([{
    id: noteId,
    position: { x: 1, y: -1 },
  }])
})

integrationTest("fails clearly when another session holds the migration lock", async () => {
  if (!migrationDatabaseUrl) {
    throw new Error("migration database URL was not configured")
  }

  const blocker = postgres(migrationDatabaseUrl, { max: 1, prepare: false })
  const reserved = await blocker.reserve()
  const migrating = createPersistence({
    databaseUrl: migrationDatabaseUrl,
    migrationLockTimeoutMs: 75,
    migrationLockPollMs: 10,
  })

  try {
    await reserved`select pg_advisory_lock(hashtext(${MIGRATION_LOCK_NAME}))`
    await expect(migrating.migrate()).rejects.toThrow("migration lock")
  } finally {
    await reserved`select pg_advisory_unlock(hashtext(${MIGRATION_LOCK_NAME}))`.catch(() => undefined)
    await reserved.release()
    await blocker.end({ timeout: 5 })
    await migrating.close()
  }
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

integrationTest("publishes an established Sticky Note as empty text with Last Edit and CAS conflict durability", async () => {
  if (!persistence) {
    throw new Error("persistence was not initialized")
  }

  const createdAt = new Date("2026-08-10T00:00:00.000Z")
  const editedAt = new Date("2026-08-10T00:00:01.000Z")
  const registered = await persistence.registerUser({
    username: "edit_writer",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "k".repeat(64),
    now: createdAt,
    expiresAt: new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }
  const boardId = "KdeFgHiJkLmNoPqRsTuVwX"
  await persistence.createBoard({
    publicId: boardId,
    name: "Established Empty",
    ownerUserId: registered.user.id,
    joinCodeHash: "a".repeat(64),
    now: createdAt,
  })
  await expect(persistence.createStickyNote({
    publicId: "LdeFgHiJkLmNoPqRsTuVwX",
    boardId,
    userId: registered.user.id,
    text: "initial text",
    position: { x: 0, y: 0 },
    color: "yellow",
    now: createdAt,
  })).resolves.toMatchObject({ kind: "created", revision: 1 })

  const updated = await persistence.updateStickyNoteText({
    boardId,
    stickyNoteId: "LdeFgHiJkLmNoPqRsTuVwX",
    userId: registered.user.id,
    text: "",
    expectedTextVersion: 1,
    now: editedAt,
  })
  expect(updated).toMatchObject({
    kind: "updated",
    revision: 2,
    stickyNote: {
      text: "",
      textVersion: 2,
      lastEdit: {
        member: { username: "edit_writer" },
        at: editedAt.toISOString(),
      },
    },
  })

  const stale = await persistence.updateStickyNoteText({
    boardId,
    stickyNoteId: "LdeFgHiJkLmNoPqRsTuVwX",
    userId: registered.user.id,
    text: "stale optimistic text",
    expectedTextVersion: 1,
    now: new Date("2026-08-10T00:00:02.000Z"),
  })
  expect(stale).toMatchObject({
    kind: "text_version_conflict",
    revision: 2,
    stickyNote: { text: "", textVersion: 2 },
  })

  const opened = await persistence.openBoard({ userId: registered.user.id, publicId: boardId })
  expect(opened).toMatchObject({
    revision: 2,
    stickyNotes: [{ id: "LdeFgHiJkLmNoPqRsTuVwX", text: "", textVersion: 2 }],
  })
})

integrationTest("serializes competing established text publications by the locked Sticky Note version", async () => {
  if (!persistence || !concurrentPersistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "edit_racer",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "m".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }
  const boardId = "MdeFgHiJkLmNoPqRsTuVwX"
  const noteId = "NdeFgHiJkLmNoPqRsTuVwX"
  await persistence.createBoard({
    publicId: boardId,
    name: "Edit Race",
    ownerUserId: registered.user.id,
    joinCodeHash: "b".repeat(64),
    now,
  })
  await persistence.createStickyNote({
    publicId: noteId,
    boardId,
    userId: registered.user.id,
    text: "race start",
    position: { x: 0, y: 0 },
    color: "yellow",
    now,
  })

  const results = await Promise.all([
    persistence.updateStickyNoteText({
      boardId,
      stickyNoteId: noteId,
      userId: registered.user.id,
      text: "first committed writer",
      expectedTextVersion: 1,
      now,
    }),
    concurrentPersistence.updateStickyNoteText({
      boardId,
      stickyNoteId: noteId,
      userId: registered.user.id,
      text: "second stale writer",
      expectedTextVersion: 1,
      now,
    }),
  ])

  const winner = results.find((result) => result.kind === "updated")
  const loser = results.find((result) => result.kind === "text_version_conflict")
  expect(winner).toBeDefined()
  expect(loser).toBeDefined()
  expect(loser).toMatchObject({
    kind: "text_version_conflict",
    revision: 2,
    stickyNote: {
      text: winner?.kind === "updated" ? winner.stickyNote.text : "",
      textVersion: 2,
    },
  })
  const opened = await persistence.openBoard({ userId: registered.user.id, publicId: boardId })
  expect(opened?.revision).toBe(2)
  expect(opened?.stickyNotes).toMatchObject([{
    id: noteId,
    textVersion: 2,
  }])
  const finalText = opened?.stickyNotes?.[0]?.text
  expect(finalText === "first committed writer" || finalText === "second stale writer").toBe(true)
})

integrationTest("serializes concurrent Color changes by Board revision and preserves other Sticky Note fields", async () => {
  if (!persistence || !concurrentPersistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "color_racer",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "n".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }

  const boardId = "UdeFgHiJkLmNoPqRsTuVwX"
  const noteId = "VdeFgHiJkLmNoPqRsTuVwX"
  await persistence.createBoard({
    publicId: boardId,
    name: "Color Race",
    ownerUserId: registered.user.id,
    joinCodeHash: "c".repeat(64),
    now,
  })
  await persistence.createStickyNote({
    publicId: noteId,
    boardId,
    userId: registered.user.id,
    text: "text remains durable",
    position: { x: 7, y: -3 },
    color: "yellow",
    now,
  })

  const results = await Promise.all([
    persistence.recolorStickyNote({ boardId, stickyNoteId: noteId, userId: registered.user.id, color: "blue" }),
    concurrentPersistence.recolorStickyNote({ boardId, stickyNoteId: noteId, userId: registered.user.id, color: "magenta" }),
  ])

  expect(results.map((result) => result.kind)).toEqual(["recolored", "recolored"])
  expect(results.map((result) => result.kind === "recolored" ? result.revision : 0).sort()).toEqual([2, 3])
  const opened = await persistence.openBoard({ userId: registered.user.id, publicId: boardId })
  expect(opened).toMatchObject({
    revision: 3,
    stickyNotes: [{
      id: noteId,
      text: "text remains durable",
      textVersion: 1,
      position: { x: 7, y: -3 },
      authorship: { member: { username: "color_racer" } },
      lastEdit: { member: { username: "color_racer" } },
    }],
  })
  expect(["blue", "magenta"]).toContain(opened?.stickyNotes?.[0]?.color ?? "")
})

integrationTest("deletes a Sticky Note transactionally, compacts Stacking Order, and rejects later mutations", async () => {
  if (!persistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "delete_writer",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "p".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }

  const boardId = "WdeFgHiJkLmNoPqRsTuVwX"
  const noteIds = [
    "XdeFgHiJkLmNoPqRsTuVwX",
    "YdeFgHiJkLmNoPqRsTuVwX",
    "ZdeFgHiJkLmNoPqRsTuVwX",
  ]
  await persistence.createBoard({
    publicId: boardId,
    name: "Deletion",
    ownerUserId: registered.user.id,
    joinCodeHash: "d".repeat(64),
    now,
  })
  for (const [index, noteId] of noteIds.entries()) {
    await persistence.createStickyNote({
      publicId: noteId,
      boardId,
      userId: registered.user.id,
      text: `delete ${index}`,
      position: { x: index, y: 0 },
      color: "yellow",
      now,
    })
  }

  const deleted = await persistence.deleteStickyNote({
    boardId,
    stickyNoteId: noteIds[1]!,
    userId: registered.user.id,
  })
  expect(deleted).toMatchObject({
    kind: "deleted",
    stickyNoteId: noteIds[1],
    revision: 4,
    affectedStickyNotes: [{ id: noteIds[2], stackingOrder: 1 }],
  })

  const opened = await persistence.openBoard({ userId: registered.user.id, publicId: boardId })
  expect(opened).toMatchObject({
    revision: 4,
    stickyNotes: [
      { id: noteIds[0], stackingOrder: 0 },
      { id: noteIds[2], stackingOrder: 1 },
    ],
  })
  expect(opened?.stickyNotes).toHaveLength(2)

  await expect(persistence.deleteStickyNote({
    boardId,
    stickyNoteId: noteIds[1]!,
    userId: registered.user.id,
  })).resolves.toEqual({
    kind: "not_found",
    revision: 4,
  })
  await expect(persistence.moveStickyNote({
    boardId,
    stickyNoteId: noteIds[1]!,
    userId: registered.user.id,
    direction: "right",
  })).resolves.toEqual({ kind: "not_found" })
  await expect(persistence.openBoard({ userId: registered.user.id, publicId: boardId })).resolves.toMatchObject({
    revision: 4,
    stickyNotes: [
      { id: noteIds[0], stackingOrder: 0 },
      { id: noteIds[2], stackingOrder: 1 },
    ],
  })
})

integrationTest("rolls back Sticky Note deletion and Board revision together on PostgreSQL failure", async () => {
  if (!persistence || !databaseUrl) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "delete_rollback",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "rollback-delete-23".padEnd(64, "r"),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }

  const boardId = "delete23-rb-board-001x"
  const noteId = "delete23-rb-note-001xx"
  await persistence.createBoard({
    publicId: boardId,
    name: "Delete Rollback",
    ownerUserId: registered.user.id,
    joinCodeHash: "a".repeat(64),
    now,
  })
  await persistence.createStickyNote({
    publicId: noteId,
    boardId,
    userId: registered.user.id,
    text: "must survive rollback",
    position: { x: 0, y: 0 },
    color: "yellow",
    now,
  })

  const triggerClient = postgres(databaseUrl, { max: 1, prepare: false })
  try {
    await triggerClient.unsafe(`
      create or replace function tuiscrib_delete23_rollback() returns trigger
      language plpgsql as $$
      begin
        if new.public_id = '${boardId}' and new.revision = 2 then
          raise exception 'delete23 rollback sentinel';
        end if;
        return new;
      end;
      $$;
      create trigger tuiscrib_delete23_rollback_trigger
      before update of revision on boards
      for each row execute function tuiscrib_delete23_rollback();
    `)

    await expect(persistence.deleteStickyNote({
      boardId,
      stickyNoteId: noteId,
      userId: registered.user.id,
    })).rejects.toThrow("Failed query: update")

    await expect(persistence.openBoard({
      userId: registered.user.id,
      publicId: boardId,
    })).resolves.toMatchObject({
      revision: 1,
      stickyNotes: [{ id: noteId, text: "must survive rollback", stackingOrder: 0 }],
    })

    await triggerClient.unsafe(`
      drop trigger tuiscrib_delete23_rollback_trigger on boards;
      drop function tuiscrib_delete23_rollback();
    `)
    await expect(persistence.deleteStickyNote({
      boardId,
      stickyNoteId: noteId,
      userId: registered.user.id,
    })).resolves.toMatchObject({ kind: "deleted", stickyNoteId: noteId, revision: 2 })
  } finally {
    await triggerClient.unsafe(`
      drop trigger if exists tuiscrib_delete23_rollback_trigger on boards;
      drop function if exists tuiscrib_delete23_rollback();
    `).catch(() => undefined)
    await triggerClient.end({ timeout: 5 })
  }
})

integrationTest("resolves delete races by PostgreSQL commit order in both directions", async () => {
  if (!persistence || !concurrentPersistence) {
    throw new Error("persistence was not initialized")
  }

  const now = new Date("2026-08-10T00:00:00.000Z")
  const registered = await persistence.registerUser({
    username: "delete_racer",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$test$hash",
    credentialHash: "q".repeat(64),
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
  })
  if (!registered) {
    throw new Error("user was not registered")
  }

  const deleteFirstBoard = "delete23-race-board-01"
  const deleteFirstNote = "delete23-race-note-001"
  await persistence.createBoard({
    publicId: deleteFirstBoard,
    name: "Delete first",
    ownerUserId: registered.user.id,
    joinCodeHash: "e".repeat(64),
    now,
  })
  await persistence.createStickyNote({
    publicId: deleteFirstNote,
    boardId: deleteFirstBoard,
    userId: registered.user.id,
    text: "delete first",
    position: { x: 0, y: 0 },
    color: "yellow",
    now,
  })
  const deleteFirst = await persistence.deleteStickyNote({
    boardId: deleteFirstBoard,
    stickyNoteId: deleteFirstNote,
    userId: registered.user.id,
  })
  const moveAfterDelete = await concurrentPersistence.moveStickyNote({
    boardId: deleteFirstBoard,
    stickyNoteId: deleteFirstNote,
    userId: registered.user.id,
    direction: "right",
  })
  expect(deleteFirst).toEqual({ kind: "deleted", stickyNoteId: deleteFirstNote, revision: 2 })
  expect(moveAfterDelete).toEqual({ kind: "not_found" })
  await expect(persistence.openBoard({ userId: registered.user.id, publicId: deleteFirstBoard })).resolves.toMatchObject({
    revision: 2,
    stickyNotes: [],
  })

  const moveFirstBoard = "delete23-race-board-02"
  const moveFirstNote = "delete23-race-note-002"
  await persistence.createBoard({
    publicId: moveFirstBoard,
    name: "Move first",
    ownerUserId: registered.user.id,
    joinCodeHash: "f".repeat(64),
    now,
  })
  await persistence.createStickyNote({
    publicId: moveFirstNote,
    boardId: moveFirstBoard,
    userId: registered.user.id,
    text: "move first",
    position: { x: 0, y: 0 },
    color: "yellow",
    now,
  })
  const moveFirst = await persistence.moveStickyNote({
    boardId: moveFirstBoard,
    stickyNoteId: moveFirstNote,
    userId: registered.user.id,
    direction: "right",
  })
  const deleteAfterMove = await concurrentPersistence.deleteStickyNote({
    boardId: moveFirstBoard,
    stickyNoteId: moveFirstNote,
    userId: registered.user.id,
  })
  expect(moveFirst).toMatchObject({ kind: "moved", revision: 2, stickyNote: { position: { x: 1, y: 0 } } })
  expect(deleteAfterMove).toEqual({ kind: "deleted", stickyNoteId: moveFirstNote, revision: 3 })
  await expect(persistence.openBoard({ userId: registered.user.id, publicId: moveFirstBoard })).resolves.toMatchObject({
    revision: 3,
    stickyNotes: [],
  })
})

integrationTest("recreates pooled connections after disposable PostgreSQL terminates them", async () => {
  if (!persistence || !databaseUrl) {
    throw new Error("persistence was not initialized")
  }

  const terminator = postgres(databaseUrl, { max: 1, prepare: false })
  try {
    await persistence.healthCheck()
    const terminated = await terminator`
      select pg_terminate_backend(pid) as terminated
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and application_name = 'tuiscrib-test-primary'
    `
    expect(terminated.some((row) => row.terminated === true)).toBe(true)
    await expect(persistence.healthCheck()).rejects.toThrow()
    await expect(persistence.healthCheck()).resolves.toEqual({ database: "ready" })
  } finally {
    await terminator.end({ timeout: 5 })
  }
})

function capacityNoteId(index: number): string {
  return `N${index.toString().padStart(21, "0")}`
}
