import { expect, test } from "bun:test"

import { createServiceApp } from "./app.ts"
import { createBoardAdministration, createJoinCode, formatJoinCode } from "./boards.ts"

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

test("joins a Board through authenticated HTTP and hashes the Join Code", async () => {
  let joinInput: { userId: number; joinCodeHash: string; now: Date } | undefined
  const app = createServiceApp({
    persistence: persistenceForBoards({
      joinBoard: async (input: { userId: number; joinCodeHash: string; now: Date }) => {
        joinInput = input
        return { kind: "joined" as const, board: { ...board, role: "member" as const } }
      },
    }),
    clock: () => new Date("2026-08-10T00:00:00.000Z"),
  })

  const response = await app.request("http://tuiscrib.test/boards/join", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ joinCode: joinCode.toLowerCase() }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    board: { ...board, role: "member" },
  })
  expect(joinInput).toEqual({
    userId: 7,
    joinCodeHash: "b4c42461ad13439dd10d9b7b2f1fac13d5357a53633194aa453ef0103f1a9532",
    now: new Date("2026-08-10T00:00:00.000Z"),
  })
  expect(JSON.stringify(joinInput)).not.toContain(joinCode)
})

test("does not disclose invalid Join Codes and rate-limits repeated attempts", async () => {
  let joinCalls = 0
  let now = 0
  const app = createServiceApp({
    persistence: persistenceForBoards({
      joinBoard: async () => {
        joinCalls += 1
        return { kind: "invalid_join_code" as const }
      },
    }),
    clock: () => new Date(now),
    boardRateLimit: { maxAttempts: 2, windowMs: 1_000 },
  })
  const request = () => app.request("http://tuiscrib.test/boards/join", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.77",
    },
    body: JSON.stringify({ joinCode }),
  })

  const first = await request()
  const second = await request()
  const limited = await request()

  expect(first.status).toBe(404)
  expect(second.status).toBe(404)
  expect(limited.status).toBe(429)
  expect(joinCalls).toBe(2)
  expect(await first.text()).not.toContain(joinCode)
  expect(await second.text()).not.toContain(joinCode)
  expect(await limited.text()).not.toContain(joinCode)
  expect(limited.headers.get("retry-after")).toBe("1")

  now = 1_000
  expect((await request()).status).toBe(404)
})

test("prevents the Owner from leaving through authenticated HTTP", async () => {
  const app = createServiceApp({
    persistence: persistenceForBoards({
      leaveBoard: async () => ({ kind: "owner_cannot_leave" as const }),
    }),
  })

  const response = await app.request(`http://tuiscrib.test/boards/${board.id}/leave`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    error: "The Owner cannot leave this Board.",
    code: "owner_cannot_leave",
  })
})

test("renames a Board and rotates its Join Code through authenticated Owner HTTP", async () => {
  const rotatedJoinCode = "WXYZ-2345-6789-ABCD-EFGH-JKMN-PQ"
  let renameInput: Record<string, unknown> | undefined
  let rotateInput: Record<string, unknown> | undefined
  const app = createServiceApp({
    persistence: persistenceForBoards({
      renameBoard: async (input: Record<string, unknown>) => {
        renameInput = input
        return {
          kind: "renamed" as const,
          board: { ...board, name: "Renamed Ideas" },
        }
      },
      rotateJoinCode: async (input: Record<string, unknown>) => {
        rotateInput = input
        return {
          kind: "rotated" as const,
          board: { ...board },
        }
      },
    }),
    clock: () => new Date("2026-08-10T00:00:00.000Z"),
    joinCodeGenerator: () => rotatedJoinCode.replaceAll("-", ""),
  })

  const renamed = await app.request(`http://tuiscrib.test/boards/${board.id}/rename`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: " Renamed Ideas " }),
  })
  const rotated = await app.request(
    `http://tuiscrib.test/boards/${board.id}/rotate-join-code`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    },
  )

  expect(renamed.status).toBe(200)
  expect(await renamed.json()).toEqual({
    board: { ...board, name: "Renamed Ideas" },
  })
  expect(rotated.status).toBe(200)
  expect(await rotated.json()).toEqual({ board, joinCode: rotatedJoinCode })
  expect(renameInput).toEqual({
    userId: 7,
    publicId: board.id,
    name: "Renamed Ideas",
  })
  expect(rotateInput).toEqual({
    userId: 7,
    publicId: board.id,
    joinCodeHash: "f8f346a3921d1694def514b86136e345d16ada41aa4b7ef35ac0e2f5e6bfb45d",
  })
  expect(JSON.stringify(rotateInput)).not.toContain(rotatedJoinCode)
})

test("rejects non-Owner Board governance without disclosing Join Code values", async () => {
  const app = createServiceApp({
    persistence: persistenceForBoards({
      renameBoard: async () => ({ kind: "not_owner" as const }),
      rotateJoinCode: async () => ({ kind: "not_owner" as const }),
    }),
    joinCodeGenerator: () => joinCode,
  })

  const renamed = await app.request(`http://tuiscrib.test/boards/${board.id}/rename`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Nope" }),
  })
  const rotated = await app.request(
    `http://tuiscrib.test/boards/${board.id}/rotate-join-code`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    },
  )

  expect(renamed.status).toBe(403)
  expect(await renamed.json()).toEqual({
    error: "Only the Owner may rename this Board.",
    code: "owner_required",
  })
  expect(rotated.status).toBe(403)
  const rotatedBody = await rotated.text()
  expect(JSON.parse(rotatedBody)).toEqual({
    error: "Only the Owner may rotate this Join Code.",
    code: "owner_required",
  })
  expect(rotatedBody).not.toContain(joinCode)
})

test("deletes a Board through the authenticated Owner action and emits no Board state", async () => {
  let deleteInput: Record<string, unknown> | undefined
  const app = createServiceApp({
    persistence: persistenceForBoards({
      deleteBoard: async (input: Record<string, unknown>) => {
        deleteInput = input
        return { kind: "deleted" as const }
      },
    }),
  })

  const response = await app.request(`http://tuiscrib.test/boards/${board.id}/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  })

  expect(response.status).toBe(200)
  const body = await response.text()
  expect(JSON.parse(body)).toEqual({ status: "deleted" })
  expect(deleteInput).toEqual({ userId: 7, publicId: board.id })
  expect(body).not.toContain(board.name)
})

test("maps a persistence Owner check to a nondisclosing authorization failure", async () => {
  const app = createServiceApp({
    persistence: persistenceForBoards({
      deleteBoard: async () => ({ kind: "not_owner" as const }),
    }),
  })

  const response = await app.request(`http://tuiscrib.test/boards/${board.id}/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    error: "Only the Owner may delete this Board.",
    code: "owner_required",
  })
})

test("notifies collaboration only after durable Board deletion", async () => {
  const notifications: string[] = []
  const administration = createBoardAdministration({
    persistence: {
      createBoard: async () => ({ kind: "created" as const, board }),
      listBoards: async () => [board],
      deleteBoard: async () => ({ kind: "deleted" as const }),
    },
    onBoardDeleted: (publicId) => notifications.push(publicId),
  })

  await expect(administration.deleteBoard({ id: 7, username: "ada_lovelace" }, board.id)).resolves.toEqual({
    kind: "success",
    response: { status: "deleted" },
  })
  expect(notifications).toEqual([board.id])
})
