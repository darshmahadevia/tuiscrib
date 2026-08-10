import { expect, test } from "bun:test"

import { createServiceApp } from "./app.ts"
import { createBoardCollaboration } from "./collaboration.ts"

const credential = "a".repeat(43)
const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
const board = {
  id: boardId,
  name: "Private Ideas",
  role: "member" as const,
}

function persistenceForCollaboration(overrides: Record<string, unknown> = {}) {
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
    openBoard: async () => ({
      board,
      revision: 0,
    }),
    ...overrides,
  }
}

test("authorizes a current Member for the Board collaboration preflight without returning private state", async () => {
  let openInput: Record<string, unknown> | undefined
  const app = createServiceApp({
    persistence: persistenceForCollaboration({
      openBoard: async (input: Record<string, unknown>) => {
        openInput = input
        return { board, revision: 7 }
      },
    }),
  })

  const response = await app.request(`http://tuiscrib.test/boards/${boardId}/collaboration`, {
    headers: { authorization: `Bearer ${credential}` },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const body = await response.text()
  expect(JSON.parse(body)).toEqual({ status: "ready" })
  expect(openInput).toEqual({ userId: 7, publicId: boardId })
  expect(body).not.toContain(board.name)
})

test("rejects a missing Terminal Session before any Board lookup", async () => {
  let openCalled = false
  const app = createServiceApp({
    persistence: persistenceForCollaboration({
      authenticateTerminalSession: async () => null,
      openBoard: async () => {
        openCalled = true
        return { board, revision: 0 }
      },
    }),
  })

  const response = await app.request(`http://tuiscrib.test/boards/${boardId}/collaboration`)

  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({
    error: "Your Terminal Session is invalid. Sign in again.",
    code: "invalid_session",
  })
  expect(openCalled).toBe(false)
})

test("gives nonexistent and non-member Boards the same nondisclosing error", async () => {
  const app = createServiceApp({
    persistence: persistenceForCollaboration({
      openBoard: async () => null,
    }),
  })

  const [missing, notMember] = await Promise.all([
    app.request(`http://tuiscrib.test/boards/${boardId}/collaboration`, {
      headers: { authorization: `Bearer ${credential}` },
    }),
    app.request("http://tuiscrib.test/boards/AbCdEfGhIjKlMnOpQrStUv/collaboration", {
      headers: { authorization: `Bearer ${credential}` },
    }),
  ])
  const missingBody = await missing.text()
  const notMemberBody = await notMember.text()

  expect(missing.status).toBe(404)
  expect(notMember.status).toBe(404)
  expect(missing.headers.get("cache-control")).toBe("no-store")
  expect(notMember.headers.get("cache-control")).toBe("no-store")
  expect(missingBody).toBe(notMemberBody)
  expect(missingBody).not.toContain(board.name)
  expect(missingBody).not.toContain("revision")
})

type SocketClient = {
  socket: WebSocket
  nextMessage(): Promise<Record<string, unknown>>
}

function createSocketClient(url: string, credentialValue: string): SocketClient {
  const WebSocketConstructor = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket
  const socket = new WebSocketConstructor(url, {
    headers: { authorization: `Bearer ${credentialValue}` },
  })
  const messages: Record<string, unknown>[] = []
  const waiters: Array<(message: Record<string, unknown>) => void> = []
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter) {
      waiter(message)
    } else {
      messages.push(message)
    }
  })

  return {
    socket,
    nextMessage() {
      const message = messages.shift()
      if (message) {
        return Promise.resolve(message)
      }
      return new Promise((resolve) => waiters.push(resolve))
    },
  }
}

async function nextMessageMatching(
  client: SocketClient,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const message = await client.nextMessage()
    if (predicate(message)) {
      return message
    }
  }
  throw new Error("WebSocket did not deliver the expected snapshot")
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true })
  })
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return
  }
  await new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true })
    socket.close()
  })
}

test("sends one authoritative snapshot first, deduplicates duplicate Sessions, and removes Presence on disconnect", async () => {
  const collaboration = createBoardCollaboration({
    persistence: {
      openBoard: async ({ userId, publicId }) => ({
        board: {
          id: publicId,
          name: "Live Ideas",
          role: userId === 7 ? "owner" : "member",
        },
        revision: 6,
      }),
    },
    sessionAuthenticator: async (value) => {
      if (value === credential) {
        return { user: { id: 7, username: "ada_lovelace" } }
      }
      if (value === "b".repeat(43)) {
        return { user: { id: 8, username: "grace_hopper" } }
      }
      return null
    },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const result = await collaboration.handleUpgrade(request, bunServer)
      if (result !== null) {
        return result
      }
      return new Response("not found", { status: 404 })
    },
    websocket: collaboration.websocket,
  })
  const url = `ws://127.0.0.1:${server.port}/boards/${boardId}/collaboration`
  const owner = createSocketClient(url, credential)
  const member = createSocketClient(url, "b".repeat(43))
  const duplicateOwner = createSocketClient(url, credential)

  try {
    await Promise.all([
      waitForSocketOpen(owner.socket),
      waitForSocketOpen(member.socket),
      waitForSocketOpen(duplicateOwner.socket),
    ])

    const [ownerFirst, memberFirst, duplicateFirst] = await Promise.all([
      owner.nextMessage(),
      member.nextMessage(),
      duplicateOwner.nextMessage(),
    ])
    expect(ownerFirst).toMatchObject({ type: "snapshot", revision: 6 })
    expect(memberFirst).toMatchObject({ type: "snapshot", revision: 6 })
    expect(duplicateFirst).toMatchObject({ type: "snapshot", revision: 6 })
    expect((duplicateFirst.presence as unknown[]).length).toBe(2)

    const ownerAfterConnections = await nextMessageMatching(
      owner,
      (message) => (message.presence as unknown[]).length === 2,
    )
    expect(ownerAfterConnections).toMatchObject({
      type: "snapshot",
      presence: [
        { member: { username: "ada_lovelace" }, activity: "viewing" },
        { member: { username: "grace_hopper" }, activity: "viewing" },
      ],
    })

    await closeSocket(member.socket)
    const ownerAfterMemberDisconnect = await nextMessageMatching(
      owner,
      (message) => (message.presence as unknown[]).length === 1,
    )
    expect(ownerAfterMemberDisconnect).toMatchObject({
      type: "snapshot",
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
    })

    await closeSocket(duplicateOwner.socket)
    expect(owner.socket.readyState).toBe(WebSocket.OPEN)
  } finally {
    await Promise.all([
      closeSocket(owner.socket),
      closeSocket(member.socket),
      closeSocket(duplicateOwner.socket),
    ])
    await server.stop(true)
  }
})

test("grants creation authority before publication and broadcasts one durable revisioned Sticky Note", async () => {
  const provisionalId = "71ed2c45-67be-4a55-a5ae-90aafc1ecb1c"
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "First durable note",
    textVersion: 1,
    position: { x: 3, y: -1 },
    color: "yellow" as const,
    stackingOrder: 0,
    authorship: { member: { username: "ada_lovelace" } },
    createdAt: "2026-08-10T00:00:00.000Z",
    lastEdit: {
      member: { username: "ada_lovelace" },
      at: "2026-08-10T00:00:00.000Z",
    },
  }
  const createInputs: Array<Record<string, unknown>> = []
  let releaseCreation!: () => void
  const creationMayCommit = new Promise<void>((resolve) => {
    releaseCreation = resolve
  })
  let creationStarted!: () => void
  const creationStartedPromise = new Promise<void>((resolve) => {
    creationStarted = resolve
  })
  const collaboration = createBoardCollaboration({
    clock: () => new Date("2026-08-10T00:00:00.000Z"),
    persistence: {
      openBoard: async ({ userId, publicId }) => ({
        board: {
          id: publicId,
          name: "Creation Ideas",
          role: userId === 7 ? "owner" : "member",
        },
        revision: 0,
        stickyNotes: [],
      }),
      createStickyNote: async (input: Record<string, unknown>) => {
        createInputs.push(input)
        creationStarted()
        await creationMayCommit
        return { kind: "created" as const, revision: 1, stickyNote: note }
      },
    },
    sessionAuthenticator: async (value) => {
      if (value === credential) {
        return { user: { id: 7, username: "ada_lovelace" } }
      }
      if (value === "b".repeat(43)) {
        return { user: { id: 8, username: "grace_hopper" } }
      }
      return null
    },
    stickyNoteIdGenerator: () => note.id,
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const result = await collaboration.handleUpgrade(request, bunServer)
      if (result !== null) {
        return result
      }
      return new Response("not found", { status: 404 })
    },
    websocket: collaboration.websocket,
  })
  const url = `ws://127.0.0.1:${server.port}/boards/${boardId}/collaboration`
  const owner = createSocketClient(url, credential)
  const member = createSocketClient(url, "b".repeat(43))

  try {
    await Promise.all([waitForSocketOpen(owner.socket), waitForSocketOpen(member.socket)])
    await owner.nextMessage()
    await member.nextMessage()
    await nextMessageMatching(owner, (message) => (message.presence as unknown[]).length === 2)

    owner.socket.send(JSON.stringify({
      type: "begin_sticky_note",
      provisionalId,
      position: { x: 3, y: -1 },
      color: "yellow",
    }))

    const claim = await nextMessageMatching(
      owner,
      (message) => message.type === "sticky_note_creation_claim_granted",
    )
    const claimId = String(claim.claimId)
    expect(claim).toMatchObject({
      type: "sticky_note_creation_claim_granted",
      provisionalId,
      position: { x: 3, y: -1 },
      color: "yellow",
    })
    const creatingPresence = await nextMessageMatching(
      member,
      (message) =>
        message.type === "snapshot" &&
        (message.presence as Array<{ member: { username: string }; activity: string }>).some(
          (presence) => presence.member.username === "ada_lovelace" && presence.activity === "creating",
        ),
    )
    expect(creatingPresence).toMatchObject({ type: "snapshot", revision: 0 })
    expect(createInputs).toHaveLength(0)

    const privateText = "do not echo this text"
    member.socket.send(JSON.stringify({
      type: "publish_sticky_note",
      claimId: "invalid-claim",
      provisionalId,
      text: privateText,
    }))
    const invalidPayloadError = await nextMessageMatching(member, (message) => message.type === "error")
    expect(invalidPayloadError).toMatchObject({ type: "error", code: "invalid_command" })
    expect(JSON.stringify(invalidPayloadError)).not.toContain(privateText)

    member.socket.send(JSON.stringify({
      type: "begin_sticky_note",
      provisionalId,
      position: { x: 3, y: -1 },
      color: "yellow",
    }))
    await expect(nextMessageMatching(member, (message) => message.type === "error"))
      .resolves.toMatchObject({
        type: "error",
        code: "creation_claim_unavailable",
      })

    const publish = JSON.stringify({
      type: "publish_sticky_note",
      claimId,
      provisionalId,
      text: note.text,
    })
    owner.socket.send(publish)
    owner.socket.send(publish)
    const duplicateErrorPromise = nextMessageMatching(owner, (message) => message.type === "error")
    await creationStartedPromise
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(createInputs).toHaveLength(1)
    releaseCreation()

    await expect(duplicateErrorPromise)
      .resolves.toMatchObject({ type: "error", code: "invalid_creation_claim" })
    const [ownerCreated, memberCreated] = await Promise.all([
      nextMessageMatching(owner, (message) => message.type === "sticky_note_created"),
      nextMessageMatching(member, (message) => message.type === "sticky_note_created"),
    ])
    expect(ownerCreated).toEqual({
      type: "sticky_note_created",
      revision: 1,
      provisionalId,
      stickyNote: note,
    })
    expect(memberCreated).toEqual(ownerCreated)
    expect(createInputs).toHaveLength(1)
    expect(createInputs[0]).toMatchObject({
      boardId,
      userId: 7,
      text: note.text,
      position: note.position,
      color: note.color,
    })
    expect(createInputs).toHaveLength(1)
  } finally {
    releaseCreation()
    await Promise.all([closeSocket(owner.socket), closeSocket(member.socket)])
    server.stop(true)
  }
})
