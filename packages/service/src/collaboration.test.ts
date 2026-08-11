import { expect, test } from "bun:test"

import { createServiceApp } from "./app.ts"
import { hashCredential } from "./auth.ts"
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

test("refreshes the authoritative Board snapshot at WebSocket open after the HTTP preflight", async () => {
  let currentRevision = 1
  let upgradedData: Record<string, unknown> | undefined
  const messages: Record<string, unknown>[] = []
  const collaboration = createBoardCollaboration({
    persistence: {
      openBoard: async ({ publicId }) => ({
        board: { ...board, id: publicId },
        revision: currentRevision,
      }),
    },
    sessionAuthenticator: async (value) =>
      value === credential ? { user: { id: 7, username: "ada_lovelace" } } : null,
  })

  const response = await collaboration.handleUpgrade(
    new Request(`http://tuiscrib.test/boards/${boardId}/collaboration`, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${credential}`,
      },
    }),
    {
      upgrade: (_request: Request, options: { data: Record<string, unknown> }) => {
        upgradedData = options.data
        currentRevision = 2
        return true
      },
    } as never,
  )
  expect(response).toBeUndefined()
  expect(upgradedData).toBeDefined()

  const socket = {
    data: upgradedData,
    send(serialized: string) {
      messages.push(JSON.parse(serialized) as Record<string, unknown>)
    },
    close: () => undefined,
  }
  collaboration.websocket.open?.(socket as never)
  await Promise.resolve()
  await Promise.resolve()

  expect(messages[0]).toMatchObject({ type: "snapshot", revision: 2 })
})

test("re-authenticates an authenticated Board heartbeat to refresh Terminal Session activity", async () => {
  const heartbeatHashes: string[] = []
  let upgradedData: Record<string, unknown> | undefined
  const collaboration = createBoardCollaboration({
    persistence: {
      openBoard: async ({ publicId }) => ({
        board: { ...board, id: publicId },
        revision: 0,
      }),
    },
    sessionAuthenticator: async (value) => {
      return value === credential ? { user: { id: 7, username: "ada_lovelace" } } : null
    },
    sessionActivityAuthenticator: async (credentialHash) => {
      heartbeatHashes.push(credentialHash)
      return credentialHash === hashCredential(credential)
        ? { user: { id: 7, username: "ada_lovelace" } }
        : null
    },
  })

  const response = await collaboration.handleUpgrade(
    new Request(`http://tuiscrib.test/boards/${boardId}/collaboration`, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${credential}`,
      },
    }),
    {
      upgrade: (_request: Request, options: { data: Record<string, unknown> }) => {
        upgradedData = options.data
        return true
      },
    } as never,
  )
  expect(response).toBeUndefined()

  const socket = {
    data: upgradedData,
    send: () => undefined,
    close: () => undefined,
  }
  collaboration.websocket.open?.(socket as never)
  await Promise.resolve()
  await Promise.resolve()
  collaboration.websocket.message?.(socket as never, JSON.stringify({ type: "heartbeat" }))
  await Promise.resolve()
  await Promise.resolve()

  expect(heartbeatHashes).toEqual([hashCredential(credential)])
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
    const editingPresence = await nextMessageMatching(
      member,
      (message) =>
        message.type === "snapshot" &&
        message.revision === 1 &&
        presenceFor(message, "ada_lovelace") === "editing",
    )
    expect(editingPresence).toMatchObject({ revision: 1, stickyNotes: [note] })
  } finally {
    releaseCreation()
    await Promise.all([closeSocket(owner.socket), closeSocket(member.socket)])
    server.stop(true)
  }
})

test("releasing an empty provisional Sticky Note returns Presence to viewing without persistence", async () => {
  const provisionalId = "5ab7d4c2-2a35-4ee3-9f0f-9d0d2a92f36a"
  let createCalls = 0
  const collaboration = createBoardCollaboration({
    persistence: {
      openBoard: async ({ userId, publicId }) => ({
        board: {
          id: publicId,
          name: "Empty Ideas",
          role: userId === 7 ? "owner" : "member",
        },
        revision: 0,
        stickyNotes: [],
      }),
      createStickyNote: async () => {
        createCalls += 1
        return { kind: "created" as const, revision: 1, stickyNote: {} as never }
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
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const result = await collaboration.handleUpgrade(request, bunServer)
      return result === null ? new Response("not found", { status: 404 }) : result
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
      position: { x: 0, y: 0 },
      color: "yellow",
    }))
    const claim = await nextMessageMatching(
      owner,
      (message) => message.type === "sticky_note_creation_claim_granted",
    )
    await nextMessageMatching(
      member,
      (message) => presenceFor(message, "ada_lovelace") === "creating",
    )

    owner.socket.send(JSON.stringify({
      type: "release_sticky_note_creation",
      claimId: claim.claimId,
      provisionalId,
    }))

    const viewing = await nextMessageMatching(
      member,
      (message) => presenceFor(message, "ada_lovelace") === "viewing",
    )
    expect(viewing).toMatchObject({ revision: 0, stickyNotes: [] })
    expect(createCalls).toBe(0)
  } finally {
    await Promise.all([closeSocket(owner.socket), closeSocket(member.socket)])
    await server.stop(true)
  }
})

test("rejects over-limit publication at the public socket seam without echoing text", async () => {
  const provisionalId = "7ab7d4c2-2a35-4ee3-9f0f-9d0d2a92f36a"
  const privateText = "e\u0301".repeat(2_001)
  let createCalls = 0
  const collaboration = createBoardCollaboration({
    persistence: {
      openBoard: async ({ publicId }) => ({
        board: { id: publicId, name: "Bounded Ideas", role: "owner" as const },
        revision: 0,
        stickyNotes: [],
      }),
      createStickyNote: async () => {
        createCalls += 1
        return { kind: "empty_text" as const }
      },
    },
    sessionAuthenticator: async (value) => value === credential
      ? { user: { id: 7, username: "ada_lovelace" } }
      : null,
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const result = await collaboration.handleUpgrade(request, bunServer)
      return result === null ? new Response("not found", { status: 404 }) : result
    },
    websocket: collaboration.websocket,
  })
  const socket = createSocketClient(
    `ws://127.0.0.1:${server.port}/boards/${boardId}/collaboration`,
    credential,
  )

  try {
    await waitForSocketOpen(socket.socket)
    await socket.nextMessage()
    socket.socket.send(JSON.stringify({
      type: "begin_sticky_note",
      provisionalId,
      position: { x: 0, y: 0 },
      color: "yellow",
    }))
    const claim = await nextMessageMatching(
      socket,
      (message) => message.type === "sticky_note_creation_claim_granted",
    )
    socket.socket.send(JSON.stringify({
      type: "publish_sticky_note",
      claimId: claim.claimId,
      provisionalId,
      text: privateText,
    }))
    const error = await nextMessageMatching(socket, (message) => message.type === "error")
    expect(error).toMatchObject({
      type: "error",
      code: "sticky_note_text_limit",
      error: "Use at most 2,000 user-perceived Unicode characters.",
    })
    expect(JSON.stringify(error)).not.toContain(privateText)
    expect(createCalls).toBe(0)
  } finally {
    await closeSocket(socket.socket)
    await server.stop(true)
  }
})

test("a release during publication leaves the durable note but does not orphan editing Presence", async () => {
  const provisionalId = "6ab7d4c2-2a35-4ee3-9f0f-9d0d2a92f36a"
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "durable despite release",
    textVersion: 1,
    position: { x: 0, y: 0 },
    color: "yellow" as const,
    stackingOrder: 0,
    authorship: { member: { username: "ada_lovelace" } },
    createdAt: "2026-08-10T00:00:00.000Z",
    lastEdit: {
      member: { username: "ada_lovelace" },
      at: "2026-08-10T00:00:00.000Z",
    },
  }
  let releaseCreate!: () => void
  const createStarted = Promise.withResolvers<void>()
  const collaboration = createBoardCollaboration({
    clock: () => new Date("2026-08-10T00:00:00.000Z"),
    stickyNoteIdGenerator: () => note.id,
    persistence: {
      openBoard: async ({ userId, publicId }) => ({
        board: {
          id: publicId,
          name: "Release Ideas",
          role: userId === 7 ? "owner" : "member",
        },
        revision: 0,
        stickyNotes: [],
      }),
      createStickyNote: async () => {
        createStarted.resolve()
        await new Promise<void>((resolve) => {
          releaseCreate = resolve
        })
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
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const result = await collaboration.handleUpgrade(request, bunServer)
      return result === null ? new Response("not found", { status: 404 }) : result
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
      position: { x: 0, y: 0 },
      color: "yellow",
    }))
    const claim = await nextMessageMatching(
      owner,
      (message) => message.type === "sticky_note_creation_claim_granted",
    )
    owner.socket.send(JSON.stringify({
      type: "publish_sticky_note",
      claimId: claim.claimId,
      provisionalId,
      text: note.text,
    }))
    await createStarted.promise
    await nextMessageMatching(member, (message) => presenceFor(message, "ada_lovelace") === "creating")

    owner.socket.send(JSON.stringify({
      type: "release_sticky_note_creation",
      claimId: claim.claimId,
      provisionalId,
    }))
    await nextMessageMatching(
      member,
      (message) => presenceFor(message, "ada_lovelace") === "viewing" && message.revision === 0,
    )
    releaseCreate()

    const created = await nextMessageMatching(owner, (message) => message.type === "sticky_note_created")
    expect(created).toMatchObject({ stickyNote: note, revision: 1 })
    const viewing = await nextMessageMatching(
      member,
      (message) => presenceFor(message, "ada_lovelace") === "viewing" && message.revision === 1,
    )
    expect(viewing).toMatchObject({ stickyNotes: [note] })
  } finally {
    releaseCreate?.()
    await Promise.all([closeSocket(owner.socket), closeSocket(member.socket)])
    await server.stop(true)
  }
})

test("lost in-flight cleanup cannot erase a replacement creation claim", async () => {
  const provisionalId = "8ab7d4c2-2a35-4ee3-9f0f-9d0d2a92f36a"
  const note = {
    id: "Mm7u3nW8kM2pR5sT9vY4aB",
    text: "durable after session loss",
    textVersion: 1,
    position: { x: 0, y: 0 },
    color: "yellow" as const,
    stackingOrder: 0,
    authorship: { member: { username: "ada_lovelace" } },
    createdAt: "2026-08-10T00:00:00.000Z",
    lastEdit: {
      member: { username: "ada_lovelace" },
      at: "2026-08-10T00:00:00.000Z",
    },
  }
  let releaseCreate!: () => void
  const createStarted = Promise.withResolvers<void>()
  const collaboration = createBoardCollaboration({
    clock: () => new Date("2026-08-10T00:00:00.000Z"),
    stickyNoteIdGenerator: () => note.id,
    persistence: {
      openBoard: async ({ userId, publicId }) => ({
        board: {
          id: publicId,
          name: "Claim Recovery Ideas",
          role: userId === 7 ? "owner" : "member",
        },
        revision: 0,
        stickyNotes: [],
      }),
      createStickyNote: async () => {
        createStarted.resolve()
        await new Promise<void>((resolve) => {
          releaseCreate = resolve
        })
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
      if (value === "c".repeat(43)) {
        return { user: { id: 9, username: "alan_turing" } }
      }
      return null
    },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const result = await collaboration.handleUpgrade(request, bunServer)
      return result === null ? new Response("not found", { status: 404 }) : result
    },
    websocket: collaboration.websocket,
  })
  const url = `ws://127.0.0.1:${server.port}/boards/${boardId}/collaboration`
  const owner = createSocketClient(url, credential)
  const replacement = createSocketClient(url, "b".repeat(43))
  const observer = createSocketClient(url, "c".repeat(43))

  try {
    await Promise.all([
      waitForSocketOpen(owner.socket),
      waitForSocketOpen(replacement.socket),
      waitForSocketOpen(observer.socket),
    ])
    await Promise.all([owner.nextMessage(), replacement.nextMessage(), observer.nextMessage()])
    await nextMessageMatching(owner, (message) => (message.presence as unknown[]).length === 3)

    owner.socket.send(JSON.stringify({
      type: "begin_sticky_note",
      provisionalId,
      position: { x: 0, y: 0 },
      color: "yellow",
    }))
    const ownerClaim = await nextMessageMatching(
      owner,
      (message) => message.type === "sticky_note_creation_claim_granted",
    )
    await nextMessageMatching(
      replacement,
      (message) => presenceFor(message, "ada_lovelace") === "creating",
    )
    owner.socket.send(JSON.stringify({
      type: "publish_sticky_note",
      claimId: ownerClaim.claimId,
      provisionalId,
      text: note.text,
    }))
    await createStarted.promise

    owner.socket.send(JSON.stringify({
      type: "release_sticky_note_creation",
      claimId: ownerClaim.claimId,
      provisionalId,
    }))
    await nextMessageMatching(
      replacement,
      (message) => presenceFor(message, "ada_lovelace") === "viewing" && message.revision === 0,
    )
    await closeSocket(owner.socket)

    replacement.socket.send(JSON.stringify({
      type: "begin_sticky_note",
      provisionalId,
      position: { x: 1, y: 1 },
      color: "blue",
    }))
    await nextMessageMatching(
      replacement,
      (message) => message.type === "sticky_note_creation_claim_granted",
    )
    releaseCreate()
    await nextMessageMatching(observer, (message) => message.type === "sticky_note_created")

    observer.socket.send(JSON.stringify({
      type: "begin_sticky_note",
      provisionalId,
      position: { x: 2, y: 2 },
      color: "red",
    }))
    await expect(nextMessageMatching(observer, (message) => message.type === "error"))
      .resolves.toMatchObject({ type: "error", code: "creation_claim_unavailable" })
  } finally {
    releaseCreate?.()
    await Promise.all([
      closeSocket(owner.socket),
      closeSocket(replacement.socket),
      closeSocket(observer.socket),
    ])
    await server.stop(true)
  }
})

test("holds a distinct established Edit Claim and broadcasts only its committed full-text update", async () => {
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "durable note",
    textVersion: 1,
    position: { x: 0, y: 0 },
    color: "yellow" as const,
    stackingOrder: 0,
    authorship: { member: { username: "ada_lovelace" } },
    createdAt: "2026-08-10T00:00:00.000Z",
    lastEdit: {
      member: { username: "ada_lovelace" },
      at: "2026-08-10T00:00:00.000Z",
    },
  }
  const updatedNote = {
    ...note,
    text: "changed after commit",
    textVersion: 2,
    lastEdit: {
      member: { username: "grace_hopper" },
      at: "2026-08-10T00:00:01.000Z",
    },
  }
  const updateInputs: Array<Record<string, unknown>> = []
  const updateStarted = Promise.withResolvers<void>()
  const commitUpdate = Promise.withResolvers<void>()
  const collaboration = createBoardCollaboration({
    clock: () => new Date("2026-08-10T00:00:01.000Z"),
    persistence: {
      openBoard: async ({ userId, publicId }) => ({
        board: {
          id: publicId,
          name: "Edit Ideas",
          role: userId === 7 ? "owner" : "member",
        },
        revision: 1,
        stickyNotes: [note],
      }),
      updateStickyNoteText: async (input: Record<string, unknown>) => {
        updateInputs.push(input)
        updateStarted.resolve()
        await commitUpdate.promise
        return { kind: "updated" as const, revision: 2, stickyNote: updatedNote }
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
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const result = await collaboration.handleUpgrade(request, bunServer)
      return result === null ? new Response("not found", { status: 404 }) : result
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
      type: "begin_sticky_note_edit",
      stickyNoteId: note.id,
    }))
    const claim = await nextMessageMatching(
      owner,
      (message) => message.type === "sticky_note_edit_claim_granted",
    )
    expect(claim).toMatchObject({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      stickyNote: note,
    })
    await nextMessageMatching(
      member,
      (message) => presenceFor(message, "ada_lovelace") === "editing",
    )

    member.socket.send(JSON.stringify({
      type: "begin_sticky_note_edit",
      stickyNoteId: note.id,
    }))
    await expect(nextMessageMatching(member, (message) => message.type === "error"))
      .resolves.toMatchObject({
        type: "error",
        code: "edit_claim_unavailable",
        claimHolder: { username: "ada_lovelace" },
      })

    const claimId = String(claim.claimId)
    const publication = {
      type: "publish_sticky_note_edit",
      claimId,
      stickyNoteId: note.id,
      text: updatedNote.text,
      expectedTextVersion: note.textVersion,
    }
    owner.socket.send(JSON.stringify(publication))
    owner.socket.send(JSON.stringify(publication))
    const duplicateErrorPromise = nextMessageMatching(owner, (message) => message.type === "error")
    await updateStarted.promise
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(updateInputs).toHaveLength(1)
    expect(updateInputs[0]).toMatchObject({
      boardId,
      userId: 7,
      stickyNoteId: note.id,
      text: updatedNote.text,
      expectedTextVersion: note.textVersion,
    })
    expect(owner.socket.readyState).toBe(WebSocket.OPEN)
    commitUpdate.resolve()

    await expect(duplicateErrorPromise)
      .resolves.toMatchObject({ type: "error", code: "invalid_edit_claim" })
    const [ownerUpdated, memberUpdated] = await Promise.all([
      nextMessageMatching(owner, (message) => message.type === "sticky_note_updated"),
      nextMessageMatching(member, (message) => message.type === "sticky_note_updated"),
    ])
    expect(ownerUpdated).toEqual({
      type: "sticky_note_updated",
      revision: 2,
      stickyNote: updatedNote,
    })
    expect(memberUpdated).toEqual(ownerUpdated)

    owner.socket.send(JSON.stringify({
      type: "release_sticky_note_edit",
      claimId,
      stickyNoteId: note.id,
    }))
    await expect(nextMessageMatching(member, (message) => presenceFor(message, "ada_lovelace") === "viewing"))
      .resolves.toMatchObject({ type: "snapshot", revision: 2 })
  } finally {
    commitUpdate.resolve()
    await Promise.all([closeSocket(owner.socket), closeSocket(member.socket)])
    await server.stop(true)
  }
})

test("rejects a stale publication with the authoritative note and preserves the successful editor Presence", async () => {
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "before winner",
    textVersion: 1,
    position: { x: 0, y: 0 },
    color: "yellow" as const,
    stackingOrder: 0,
    authorship: { member: { username: "ada_lovelace" } },
    createdAt: "2026-08-10T00:00:00.000Z",
    lastEdit: {
      member: { username: "ada_lovelace" },
      at: "2026-08-10T00:00:00.000Z",
    },
  }
  const authoritative = {
    ...note,
    text: "winner text",
    textVersion: 2,
    lastEdit: {
      member: { username: "grace_hopper" },
      at: "2026-08-10T00:00:01.000Z",
    },
  }
  const updateStarted = Promise.withResolvers<void>()
  const releaseUpdate = Promise.withResolvers<void>()
  const collaboration = createBoardCollaboration({
    persistence: {
      openBoard: async ({ userId, publicId }) => ({
        board: {
          id: publicId,
          name: "Stale Edit Ideas",
          role: userId === 7 ? "owner" : "member",
        },
        revision: 1,
        stickyNotes: [note],
      }),
      updateStickyNoteText: async () => {
        updateStarted.resolve()
        await releaseUpdate.promise
        return {
          kind: "text_version_conflict" as const,
          revision: 2,
          stickyNote: authoritative,
        }
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
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const result = await collaboration.handleUpgrade(request, bunServer)
      return result === null ? new Response("not found", { status: 404 }) : result
    },
    websocket: collaboration.websocket,
  })
  const url = `ws://127.0.0.1:${server.port}/boards/${boardId}/collaboration`
  const owner = createSocketClient(url, credential)
  const observer = createSocketClient(url, "b".repeat(43))

  try {
    await Promise.all([waitForSocketOpen(owner.socket), waitForSocketOpen(observer.socket)])
    await owner.nextMessage()
    await observer.nextMessage()
    await nextMessageMatching(owner, (message) => (message.presence as unknown[]).length === 2)

    owner.socket.send(JSON.stringify({
      type: "begin_sticky_note_edit",
      stickyNoteId: note.id,
    }))
    const claim = await nextMessageMatching(
      owner,
      (message) => message.type === "sticky_note_edit_claim_granted",
    )
    await nextMessageMatching(
      observer,
      (message) => presenceFor(message, "ada_lovelace") === "editing",
    )

    const observerSnapshotPromise = nextMessageMatching(
      observer,
      (message) => message.type === "snapshot" && message.revision === 2,
    )
    owner.socket.send(JSON.stringify({
      type: "publish_sticky_note_edit",
      claimId: String(claim.claimId),
      stickyNoteId: note.id,
      text: "stale optimistic text",
      expectedTextVersion: 1,
    }))
    await updateStarted.promise
    releaseUpdate.resolve()

    const ownerSnapshot = await nextMessageMatching(
      owner,
      (message) => message.type === "snapshot" && message.revision === 2,
    )
    const conflict = await nextMessageMatching(owner, (message) => message.type === "error")
    const observerSnapshot = await observerSnapshotPromise
    expect(conflict).toMatchObject({
      type: "error",
      code: "text_version_conflict",
      authoritative: { revision: 2, stickyNote: authoritative },
    })
    expect(JSON.stringify(conflict)).not.toContain("stale optimistic text")
    expect(ownerSnapshot).toMatchObject({
      type: "snapshot",
      revision: 2,
      stickyNotes: [authoritative],
    })
    expect(ownerSnapshot.presence).toEqual(expect.arrayContaining([
      { member: { username: "ada_lovelace" }, activity: "editing" },
    ]))
    expect(observerSnapshot).toMatchObject({
      type: "snapshot",
      revision: 2,
      stickyNotes: [authoritative],
    })
    expect(JSON.stringify(observerSnapshot)).not.toContain("stale optimistic text")
  } finally {
    releaseUpdate.resolve()
    await Promise.all([closeSocket(owner.socket), closeSocket(observer.socket)])
    await server.stop(true)
  }
})

test("serializes simultaneous established Edit Claim acquisition and names the winner", async () => {
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "shared note",
    textVersion: 1,
    position: { x: 0, y: 0 },
    color: "yellow" as const,
    stackingOrder: 0,
    authorship: { member: { username: "ada_lovelace" } },
    createdAt: "2026-08-10T00:00:00.000Z",
    lastEdit: {
      member: { username: "ada_lovelace" },
      at: "2026-08-10T00:00:00.000Z",
    },
  }
  const collaboration = createBoardCollaboration({
    persistence: {
      openBoard: async ({ userId, publicId }) => ({
        board: {
          id: publicId,
          name: "Simultaneous Claim Board",
          role: userId === 7 ? "owner" : "member",
        },
        revision: 1,
        stickyNotes: [note],
      }),
      updateStickyNoteText: async () => ({ kind: "not_found" as const }),
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
      return result === null ? new Response("not found", { status: 404 }) : result
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

    const begin = JSON.stringify({
      type: "begin_sticky_note_edit",
      stickyNoteId: note.id,
    })
    owner.socket.send(begin)
    member.socket.send(begin)
    const [ownerResult, memberResult] = await Promise.all([
      nextMessageMatching(
        owner,
        (message) => message.type === "sticky_note_edit_claim_granted" || message.type === "error",
      ),
      nextMessageMatching(
        member,
        (message) => message.type === "sticky_note_edit_claim_granted" || message.type === "error",
      ),
    ])
    const results = [ownerResult, memberResult]
    expect(results.filter((message) => message.type === "sticky_note_edit_claim_granted")).toHaveLength(1)
    expect(results.filter((message) => message.type === "error")).toHaveLength(1)

    const winner = ownerResult.type === "sticky_note_edit_claim_granted"
      ? "ada_lovelace"
      : "grace_hopper"
    const rejected = results.find((message) => message.type === "error")
    expect(rejected).toMatchObject({
      type: "error",
      code: "edit_claim_unavailable",
      claimHolder: { username: winner },
    })
    expect(JSON.stringify(rejected)).not.toContain(credential)
    expect(JSON.stringify(rejected)).not.toContain("b".repeat(43))
  } finally {
    await Promise.all([closeSocket(owner.socket), closeSocket(member.socket)])
    await server.stop(true)
  }
})

function presenceFor(message: Record<string, unknown>, username: string): string | undefined {
  const presence = message.presence as Array<{ member: { username: string }; activity: string }> | undefined
  return presence?.find((entry) => entry.member.username === username)?.activity
}
