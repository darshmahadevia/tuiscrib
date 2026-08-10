import { expect, test } from "bun:test"

import { createServiceApp } from "./app.ts"
import { createJoinCode, formatJoinCode } from "./boards.ts"

const credential = "a".repeat(43)
const joinCode = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-45"
const board = {
  id: "Qx7u3nW8kM2pR5sT9vY4aB",
  name: "Ideas",
  role: "owner" as const,
}

function persistenceForBoards(overrides: Record<string, unknown> = {}) {
  return {
    healthCheck: async () => ({ database: "ready" as const }),
    findUserByUsername: async () => null,
    registerUser: async () => null,
    createTerminalSession: async () => ({ sessionId: 1 }),
    authenticateTerminalSession: async () => ({
      user: { id: 7, username: "ada_lovelace" },
    }),
    revokeTerminalSession: async () => undefined,
    createBoard: async () => ({ kind: "created" as const, board }),
    listBoards: async () => [board],
    ...overrides,
  }
}

test("creates a Board through authenticated Hono HTTP and discloses the initial Join Code once", async () => {
  let createInput: Record<string, unknown> | undefined
  const app = createServiceApp({
    persistence: persistenceForBoards({
      createBoard: async (input: Record<string, unknown>) => {
        createInput = input
        return { kind: "created" as const, board }
      },
    }),
    clock: () => new Date("2026-08-10T00:00:00.000Z"),
    boardIdGenerator: () => board.id,
    joinCodeGenerator: () => joinCode,
  })

  const response = await app.request("http://tuiscrib.test/boards", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "  Ideas  " }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ board, joinCode })
  expect(createInput).toMatchObject({
    ownerUserId: 7,
    publicId: board.id,
    name: "Ideas",
    joinCodeHash: "b4c42461ad13439dd10d9b7b2f1fac13d5357a53633194aa453ef0103f1a9532",
  })
  expect(JSON.stringify(createInput)).not.toContain(joinCode)
})

test("lists only the authenticated User's Memberships and passes the Board-name filter", async () => {
  let listInput: Record<string, unknown> | undefined
  const app = createServiceApp({
    persistence: persistenceForBoards({
      listBoards: async (input: Record<string, unknown>) => {
        listInput = input
        return [board]
      },
    }),
  })

  const response = await app.request("http://tuiscrib.test/boards?filter=idea", {
    headers: { authorization: `Bearer ${credential}` },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ boards: [board] })
  expect(listInput).toEqual({ userId: 7, nameFilter: "idea" })
})

test("rejects Board creation at the owned-Board limit without exposing a Join Code", async () => {
  const app = createServiceApp({
    persistence: persistenceForBoards({
      createBoard: async () => ({ kind: "owned_board_limit" as const }),
    }),
    joinCodeGenerator: () => joinCode,
  })

  const response = await app.request("http://tuiscrib.test/boards", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Twenty First" }),
  })
  const body = await response.text()

  expect(response.status).toBe(409)
  expect(body).toContain("at most 20")
  expect(body).not.toContain(joinCode)
})

test("generates 128-bit Join Codes in the grouped human-safe alphabet", () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    expect(formatJoinCode(createJoinCode())).toMatch(
      /^(?:[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-){6}[23456789ABCDEFGHJKMNPQRSTVWXYZ]{2}$/,
    )
  }
})

test("rejects invalid Board names before persistence and does not disclose a Join Code", async () => {
  let persistenceCalled = false
  const app = createServiceApp({
    persistence: persistenceForBoards({
      createBoard: async () => {
        persistenceCalled = true
        return { kind: "created" as const, board }
      },
    }),
    joinCodeGenerator: () => joinCode,
  })

  const response = await app.request("http://tuiscrib.test/boards", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "one\ntwo" }),
  })
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(body).toContain("single line")
  expect(body).not.toContain(joinCode)
  expect(persistenceCalled).toBe(false)
})

test("requires an authenticated Terminal Session for Board list and creation", async () => {
  const app = createServiceApp({
    persistence: persistenceForBoards(),
    joinCodeGenerator: () => joinCode,
  })

  const listResponse = await app.request("http://tuiscrib.test/boards")
  const createResponse = await app.request("http://tuiscrib.test/boards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Private" }),
  })

  expect(listResponse.status).toBe(401)
  expect(createResponse.status).toBe(401)
  expect(await listResponse.json()).toEqual({
    error: "Your Terminal Session is invalid. Sign in again.",
    code: "invalid_session",
  })
  expect(await createResponse.text()).not.toContain(joinCode)
})
