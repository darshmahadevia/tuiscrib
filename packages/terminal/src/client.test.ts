import { expect, test } from "bun:test"

import {
  createAuthClient,
  createBoardClient,
  createBoundedReconnectPolicy,
  type BoardSocket,
} from "./client.ts"

test("auth client sends registration through the public HTTP contract", async () => {
  let requestBody = ""
  const client = createAuthClient("http://tuiscrib.test", async (_input, init) => {
    requestBody = String(init?.body)
    return new Response(
      JSON.stringify({
        user: { username: "ada_lovelace" },
        sessionCredential: "opaque-session",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    )
  })

  const response = await client.register({
    username: "ada_lovelace",
    password: "correct horse",
    confirmation: "correct horse",
  })

  expect(response).toEqual({
    user: { username: "ada_lovelace" },
    sessionCredential: "opaque-session",
  })
  expect(JSON.parse(requestBody)).toEqual({
    username: "ada_lovelace",
    password: "correct horse",
    confirmation: "correct horse",
  })
})

test("auth client restores and signs out a Terminal Session through public HTTP", async () => {
  const credential = "a".repeat(43)
  const requests: Array<{ path: string; method?: string; authorization?: string; body?: string }> = []
  const client = createAuthClient("http://tuiscrib.test", async (input, init) => {
    const url = new URL(String(input))
    requests.push({
      path: url.pathname,
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? init.body : undefined,
    })

    if (url.pathname === "/auth/session") {
      return new Response(JSON.stringify({ user: { username: "ada_lovelace" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    return new Response(JSON.stringify({ status: "signed_out" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  await expect(client.restore(credential)).resolves.toEqual({
    user: { username: "ada_lovelace" },
  })
  await expect(client.signOut(credential)).resolves.toEqual({ status: "signed_out" })

  expect(requests).toEqual([
    {
      path: "/auth/session",
      method: "POST",
      authorization: `Bearer ${credential}`,
      body: undefined,
    },
    {
      path: "/auth/sign-out",
      method: "POST",
      authorization: `Bearer ${credential}`,
      body: undefined,
    },
  ])
})

test("Board client creates and filters Boards through authenticated HTTP", async () => {
  const credential = "a".repeat(43)
  const requests: Array<{
    path: string
    method?: string
    authorization?: string
    body?: string
  }> = []
  const client = createBoardClient("http://tuiscrib.test", async (input, init) => {
    const url = new URL(String(input))
    requests.push({
      path: `${url.pathname}${url.search}`,
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? init.body : undefined,
    })

    if (url.pathname === "/boards" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          board: {
            id: "Qx7u3nW8kM2pR5sT9vY4aB",
            name: "Ideas",
            role: "owner",
          },
          joinCode: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-45",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      )
    }

    return new Response(
      JSON.stringify({
        boards: [{
          id: "Qx7u3nW8kM2pR5sT9vY4aB",
          name: "Ideas",
          role: "owner",
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  })

  await expect(client.createBoard(credential, { name: "Ideas" })).resolves.toMatchObject({
    board: { name: "Ideas", role: "owner" },
  })
  await expect(client.listBoards(credential, "ideas")).resolves.toEqual({
    boards: [{
      id: "Qx7u3nW8kM2pR5sT9vY4aB",
      name: "Ideas",
      role: "owner",
    }],
  })

  expect(requests).toEqual([
    {
      path: "/boards",
      method: "POST",
      authorization: `Bearer ${credential}`,
      body: JSON.stringify({ name: "Ideas" }),
    },
    {
      path: "/boards?filter=ideas",
      method: "GET",
      authorization: `Bearer ${credential}`,
      body: undefined,
    },
  ])
})

test("Board client joins and leaves through the public HTTP actions", async () => {
  const credential = "a".repeat(43)
  const requests: Array<{ path: string; method?: string; body?: string }> = []
  const client = createBoardClient("http://tuiscrib.test", async (input, init) => {
    const url = new URL(String(input))
    requests.push({
      path: url.pathname,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    })

    if (url.pathname === "/boards/join") {
      return new Response(JSON.stringify({
        board: {
          id: "Qx7u3nW8kM2pR5sT9vY4aB",
          name: "Ideas",
          role: "member",
        },
      }), { status: 201 })
    }

    return new Response(JSON.stringify({ status: "left" }), { status: 200 })
  })

  await expect(client.joinBoard(credential, {
    joinCode: "abcd-efgh-jkmn-pqrs-tvwx-yz23-45",
  })).resolves.toEqual({
    board: {
      id: "Qx7u3nW8kM2pR5sT9vY4aB",
      name: "Ideas",
      role: "member",
    },
  })
  await expect(client.leaveBoard(credential, "Qx7u3nW8kM2pR5sT9vY4aB")).resolves.toEqual({
    status: "left",
  })

  expect(requests).toEqual([
    {
      path: "/boards/join",
      method: "POST",
      body: JSON.stringify({ joinCode: "abcd-efgh-jkmn-pqrs-tvwx-yz23-45" }),
    },
    {
      path: "/boards/Qx7u3nW8kM2pR5sT9vY4aB/leave",
      method: "POST",
      body: undefined,
    },
  ])
})

test("Board client deletes through the Owner HTTP action without sending a confirmation payload", async () => {
  const credential = "a".repeat(43)
  const requests: Array<{ path: string; method?: string; body?: string }> = []
  const client = createBoardClient("http://tuiscrib.test", async (input, init) => {
    const url = new URL(String(input))
    requests.push({
      path: url.pathname,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    return new Response(JSON.stringify({ status: "deleted" }), { status: 200 })
  })

  await expect(client.deleteBoard(credential, "Qx7u3nW8kM2pR5sT9vY4aB")).resolves.toEqual({
    status: "deleted",
  })
  expect(requests).toEqual([{
    path: "/boards/Qx7u3nW8kM2pR5sT9vY4aB/delete",
    method: "POST",
    body: undefined,
  }])
})

test("Board client treats authorization loss as terminal and never reconnects", async () => {
  const credential = "a".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  let socket: BoardSocket | undefined
  let socketClosed = false
  const scheduled: Array<() => void> = []
  const states: string[] = []
  let authorizationLoss: string | undefined
  let closeNotifications = 0
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => { socketClosed = true },
      }
      return socket
    },
    {
      heartbeatIntervalMs: 0,
      scheduler: {
        schedule(callback) {
          scheduled.push(callback)
          return callback
        },
        cancel: () => undefined,
      },
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: () => undefined,
    onError: (error) => { throw error },
    onClose: () => { closeNotifications += 1 },
    onConnectionState: (state) => states.push(state),
    onAuthorizationLost: (reason) => { authorizationLoss = reason },
  })
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "owner" },
      revision: 0,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
    }),
  })
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "board_authorization_lost",
      reason: "board_deleted",
    }),
  })
  socket?.onclose?.()

  expect(authorizationLoss).toBe("board_deleted")
  expect(socketClosed).toBe(true)
  expect(closeNotifications).toBe(0)
  expect(states).toEqual(["connecting", "connected", "closed"])
  expect(scheduled).toHaveLength(0)
  expect(() => connection.send({ type: "heartbeat" })).toThrow("closed")
})

test("Board client renames and rotates a Board through Owner HTTP actions", async () => {
  const credential = "a".repeat(43)
  const rotatedJoinCode = "WXYZ-2345-6789-ABCD-EFGH-JKMN-PQ"
  const requests: Array<{ path: string; method?: string; body?: string }> = []
  const client = createBoardClient("http://tuiscrib.test", async (input, init) => {
    const url = new URL(String(input))
    requests.push({
      path: url.pathname,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    })

    if (url.pathname.endsWith("/rename")) {
      return new Response(JSON.stringify({
        board: {
          id: "Qx7u3nW8kM2pR5sT9vY4aB",
          name: "Renamed Ideas",
          role: "owner",
        },
      }), { status: 200 })
    }

    return new Response(JSON.stringify({
      board: {
        id: "Qx7u3nW8kM2pR5sT9vY4aB",
        name: "Renamed Ideas",
        role: "owner",
      },
      joinCode: rotatedJoinCode,
    }), { status: 200 })
  })

  await expect(client.renameBoard(credential, "Qx7u3nW8kM2pR5sT9vY4aB", {
    name: "Renamed Ideas",
  })).resolves.toEqual({
    board: {
      id: "Qx7u3nW8kM2pR5sT9vY4aB",
      name: "Renamed Ideas",
      role: "owner",
    },
  })
  await expect(client.rotateJoinCode(credential, "Qx7u3nW8kM2pR5sT9vY4aB")).resolves.toEqual({
    board: {
      id: "Qx7u3nW8kM2pR5sT9vY4aB",
      name: "Renamed Ideas",
      role: "owner",
    },
    joinCode: rotatedJoinCode,
  })

  expect(requests).toEqual([
    {
      path: "/boards/Qx7u3nW8kM2pR5sT9vY4aB/rename",
      method: "POST",
      body: JSON.stringify({ name: "Renamed Ideas" }),
    },
    {
      path: "/boards/Qx7u3nW8kM2pR5sT9vY4aB/rotate-join-code",
      method: "POST",
      body: undefined,
    },
  ])
})

test("Board client preflights Membership, opens the authenticated WebSocket, and delivers snapshots", async () => {
  const credential = "a".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const requests: Array<{ path: string; method?: string; authorization?: string }> = []
  let socketUrl = ""
  let socketHeaders: Record<string, string> | undefined
  let socket: BoardSocket | undefined
  const client = createBoardClient(
    "http://tuiscrib.test",
    async (input, init) => {
      const url = new URL(String(input))
      requests.push({
        path: url.pathname,
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      })
      return new Response(JSON.stringify({ status: "ready" }), { status: 200 })
    },
    (url, options) => {
      socketUrl = url
      socketHeaders = options.headers
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => undefined,
      }
      return socket
    },
  )
  let receivedSnapshot: unknown
  let closed = false
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }
  const connection = await openBoard(credential, boardId, {
    onSnapshot: (snapshot) => {
      receivedSnapshot = snapshot
    },
    onError: (error) => {
      throw error
    },
    onClose: () => {
      closed = true
    },
  })

  expect(requests).toEqual([{
    path: `/boards/${boardId}/collaboration`,
    method: "GET",
    authorization: `Bearer ${credential}`,
  }])
  expect(socketUrl).toBe(`ws://tuiscrib.test/boards/${boardId}/collaboration`)
  expect(socketHeaders).toEqual({ authorization: `Bearer ${credential}` })

  socket?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "owner" },
      revision: 0,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
    }),
  })
  expect(receivedSnapshot).toEqual({
    type: "snapshot",
    board: { id: boardId, name: "Ideas", role: "owner" },
    revision: 0,
    presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
  })

  socket?.onclose?.()
  expect(closed).toBe(true)
  connection.close()
})

test("Board client ignores an exact duplicate snapshot without hiding a changed Presence snapshot", async () => {
  const credential = "d".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  let socket: BoardSocket | undefined
  const snapshots: unknown[] = []
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => undefined,
      }
      return socket
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onError: (error) => { throw error },
    onClose: () => undefined,
  })
  const firstSnapshot = {
    type: "snapshot",
    board: { id: boardId, name: "Ideas", role: "member" },
    revision: 4,
    presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
    stickyNotes: [],
  }
  socket?.onmessage?.({ data: JSON.stringify(firstSnapshot) })
  socket?.onmessage?.({ data: JSON.stringify(firstSnapshot) })
  socket?.onmessage?.({
    data: JSON.stringify({
      ...firstSnapshot,
      presence: [{ member: { username: "ada_lovelace" }, activity: "editing" }],
    }),
  })

  expect(snapshots).toHaveLength(2)
  expect((snapshots[1] as { presence: Array<{ activity: string }> }).presence[0]?.activity).toBe("editing")
  connection.close()
})

test("Board client sends authenticated application heartbeats and clears them on close", async () => {
  const credential = "a".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const sent: string[] = []
  const heartbeatSchedules: Array<{
    callback: () => void
    intervalMs: number
    cancelled: boolean
  }> = []
  let socket: BoardSocket | undefined
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (data) => sent.push(data),
        close: () => undefined,
      }
      return socket
    },
    {
      heartbeatIntervalMs: 1_000,
      scheduler: {
        schedule: () => undefined,
        cancel(handle) {
          if (handle && typeof handle === "object" && "cancelled" in handle) {
            ;(handle as { cancelled: boolean }).cancelled = true
          }
        },
        scheduleRepeating(callback, intervalMs) {
          const entry = { callback, intervalMs, cancelled: false }
          heartbeatSchedules.push(entry)
          return entry
        },
      },
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: () => undefined,
    onError: (error) => {
      throw error
    },
    onClose: () => undefined,
  })
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 0,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
    }),
  })

  expect(heartbeatSchedules).toMatchObject([{ intervalMs: 1_000, cancelled: false }])
  heartbeatSchedules[0]?.callback()
  expect(sent).toContain(JSON.stringify({ type: "heartbeat" }))
  connection.close()
  expect(heartbeatSchedules[0]?.cancelled).toBe(true)
  const sentAtClose = sent.length
  heartbeatSchedules[0]?.callback()
  expect(sent).toHaveLength(sentAtClose)
})

test("Board client fails closed when a WebSocket sends malformed snapshot data", async () => {
  const credential = "b".repeat(43)
  let socket: BoardSocket | undefined
  let closeCalled = false
  let receivedError: Error | undefined
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => {
          closeCalled = true
        },
      }
      return socket
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  await openBoard(credential, "Qx7u3nW8kM2pR5sT9vY4aB", {
    onSnapshot: () => {
      throw new Error("malformed snapshot was accepted")
    },
    onError: (error) => {
      receivedError = error
    },
    onClose: () => {
      throw new Error("malformed snapshot should not be reported as a clean close")
    },
  })

  socket?.onmessage?.({ data: "not-json" })
  expect(receivedError?.message).toBe("Board collaboration sent an invalid snapshot.")
  expect(closeCalled).toBe(true)
})

test("Board client sends creation commands and rejects stale or gapped durable revisions", async () => {
  const credential = "c".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  let socket: BoardSocket | undefined
  const sent: string[] = []
  const received: string[] = []
  let revisionError: Error | undefined
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (data) => sent.push(data),
        close: () => undefined,
      }
      return socket
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: () => undefined,
    onError: (error) => {
      revisionError = error
    },
    onClose: () => undefined,
    onStickyNoteCreated: (event) => received.push(`${event.stickyNote.text}@${event.revision}`),
  })

  const provisionalId = "71ed2c45-67be-4a55-a5ae-90aafc1ecb1c"
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 0,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [],
    }),
  })
  connection.send({
    type: "begin_sticky_note",
    provisionalId,
    position: { x: 0, y: 0 },
    color: "yellow",
  })
  expect(JSON.parse(sent[0] ?? "{}" )).toMatchObject({
    type: "begin_sticky_note",
    provisionalId,
  })

  socket?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_created",
      revision: 1,
      provisionalId,
      stickyNote: {
        id: "Lm7u3nW8kM2pR5sT9vY4aB",
        text: "one",
        textVersion: 1,
        position: { x: 0, y: 0 },
        color: "yellow",
        stackingOrder: 0,
        authorship: { member: { username: "ada_lovelace" } },
        createdAt: "2026-08-10T00:00:00.000Z",
        lastEdit: {
          member: { username: "ada_lovelace" },
          at: "2026-08-10T00:00:00.000Z",
        },
      },
    }),
  })
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_created",
      revision: 1,
      provisionalId,
      stickyNote: {
        id: "Lm7u3nW8kM2pR5sT9vY4aB",
        text: "stale",
        textVersion: 1,
        position: { x: 0, y: 0 },
        color: "yellow",
        stackingOrder: 0,
        authorship: { member: { username: "ada_lovelace" } },
        createdAt: "2026-08-10T00:00:00.000Z",
        lastEdit: {
          member: { username: "ada_lovelace" },
          at: "2026-08-10T00:00:00.000Z",
        },
      },
    }),
  })

  expect(received).toEqual(["one@1"])
  expect(revisionError).toBeUndefined()

  socket?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_created",
      revision: 3,
      provisionalId,
      stickyNote: {
        id: "Lm7u3nW8kM2pR5sT9vY4aB",
        text: "gap",
        textVersion: 1,
        position: { x: 0, y: 0 },
        color: "yellow",
        stackingOrder: 0,
        authorship: { member: { username: "ada_lovelace" } },
        createdAt: "2026-08-10T00:00:00.000Z",
        lastEdit: {
          member: { username: "ada_lovelace" },
          at: "2026-08-10T00:00:00.000Z",
        },
      },
    }),
  })
  expect(revisionError?.message).toContain("revision gap")
  connection.close()
})

test("Board client delivers committed Sticky Note deletion as the next durable revision", async () => {
  const credential = "e".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "delete through client",
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
  let socket: BoardSocket | undefined
  const deleted: Array<{ revision: number; stickyNoteId: string }> = []
  const snapshots: number[] = []
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => undefined,
      }
      return socket
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: (snapshot) => snapshots.push(snapshot.revision),
    onError: (error) => { throw error },
    onClose: () => undefined,
    onStickyNoteDeleted: (event) => deleted.push({
      revision: event.revision,
      stickyNoteId: event.stickyNoteId,
    }),
  })
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 4,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [note],
    }),
  })
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_deleted",
      revision: 5,
      stickyNoteId: note.id,
    }),
  })

  expect(snapshots).toEqual([4])
  expect(deleted).toEqual([{ revision: 5, stickyNoteId: note.id }])
  connection.close()
})

test("Board client sends established Edit Claim commands and delivers committed text updates", async () => {
  const credential = "d".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const sent: string[] = []
  let socket: BoardSocket | undefined
  let granted: unknown
  let updated: unknown
  let commandError: unknown
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (data) => sent.push(data),
        close: () => undefined,
      }
      return socket
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: () => undefined,
    onError: (error) => {
      throw error
    },
    onClose: () => undefined,
    onStickyNoteEditClaimGranted: (claim) => {
      granted = claim
    },
    onStickyNoteUpdated: (event) => {
      updated = event
    },
    onCommandError: (error) => {
      commandError = error
    },
  })
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "",
    textVersion: 2,
    position: { x: 0, y: 0 },
    color: "yellow" as const,
    stackingOrder: 0,
    authorship: { member: { username: "ada_lovelace" } },
    createdAt: "2026-08-10T00:00:00.000Z",
    lastEdit: {
      member: { username: "grace_hopper" },
      at: "2026-08-10T00:00:01.000Z",
    },
  }
  const claimId = "5ab7d4c2-2a35-4ee3-9f0f-9d0d2a92f36a"

  socket?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 1,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [{ ...note, text: "before edit", textVersion: 1, lastEdit: {
        member: { username: "ada_lovelace" },
        at: "2026-08-10T00:00:00.000Z",
      } }],
    }),
  })
  connection.send({ type: "begin_sticky_note_edit", stickyNoteId: note.id })
  connection.send({
    type: "publish_sticky_note_edit",
    claimId,
    stickyNoteId: note.id,
    text: "",
    expectedTextVersion: 1,
  })
  connection.send({
    type: "release_sticky_note_edit",
    claimId,
    stickyNoteId: note.id,
  })
  expect(sent.map((value) => JSON.parse(value))).toEqual([
    { type: "begin_sticky_note_edit", stickyNoteId: note.id },
    {
      type: "publish_sticky_note_edit",
      claimId,
      stickyNoteId: note.id,
      text: "",
      expectedTextVersion: 1,
    },
    { type: "release_sticky_note_edit", claimId, stickyNoteId: note.id },
  ])

  socket?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      claimId,
      stickyNote: { ...note, text: "before edit", textVersion: 1, lastEdit: {
        member: { username: "ada_lovelace" },
        at: "2026-08-10T00:00:00.000Z",
      } },
    }),
  })
  socket?.onmessage?.({
    data: JSON.stringify({ type: "sticky_note_updated", revision: 2, stickyNote: note }),
  })
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "error",
      code: "text_version_conflict",
      error: "Sticky Note text changed before this publication.",
      authoritative: { revision: 2, stickyNote: note },
    }),
  })

  expect(granted).toMatchObject({ type: "sticky_note_edit_claim_granted", claimId })
  expect(updated).toMatchObject({ type: "sticky_note_updated", revision: 2, stickyNote: { text: "" } })
  expect(commandError).toMatchObject({
    code: "text_version_conflict",
    authoritative: { revision: 2, stickyNote: { text: "" } },
  })
  connection.close()
})

test("Board client sends independent recolor commands and delivers revisioned Color events separately from text", async () => {
  const credential = "r".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const sent: string[] = []
  let socket: BoardSocket | undefined
  const recolored: unknown[] = []
  const textUpdates: unknown[] = []
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (data) => sent.push(data),
        close: () => undefined,
      }
      return socket
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: () => undefined,
    onError: (error) => {
      throw error
    },
    onClose: () => undefined,
    onStickyNoteRecolored: (event) => recolored.push(event),
    onStickyNoteUpdated: (event) => textUpdates.push(event),
  })
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "editor draft remains independent",
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
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 1,
      presence: [{ member: { username: "ada_lovelace" }, activity: "editing" }],
      stickyNotes: [note],
    }),
  })
  connection.send({ type: "recolor_sticky_note", stickyNoteId: note.id, color: "magenta" })
  expect(JSON.parse(sent[0] ?? "{}")).toEqual({
    type: "recolor_sticky_note",
    stickyNoteId: note.id,
    color: "magenta",
  })

  socket?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_recolored",
      revision: 2,
      stickyNote: { ...note, color: "magenta" },
    }),
  })
  expect(recolored).toHaveLength(1)
  expect(recolored[0]).toMatchObject({
    type: "sticky_note_recolored",
    revision: 2,
    stickyNote: { color: "magenta", text: note.text },
  })
  expect(textUpdates).toHaveLength(0)

  socket?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_updated",
      revision: 3,
      stickyNote: { ...note, color: "magenta", text: "committed text", textVersion: 2 },
    }),
  })
  expect(textUpdates).toHaveLength(1)
  expect(textUpdates[0]).toMatchObject({
    type: "sticky_note_updated",
    revision: 3,
    stickyNote: { text: "committed text", color: "magenta" },
  })
  connection.close()
})

test("Board client sends independent Stacking Order commands and delivers revisioned reorder events", async () => {
  const credential = "s".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const sent: string[] = []
  let socket: BoardSocket | undefined
  const reordered: unknown[] = []
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (data) => sent.push(data),
        close: () => undefined,
      }
      return socket
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: () => undefined,
    onError: (error) => {
      throw error
    },
    onClose: () => undefined,
    onStickyNoteReordered: (event) => reordered.push(event),
  })
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "front-to-back order",
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
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 1,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [note],
    }),
  })
  connection.send({ type: "reorder_sticky_note", stickyNoteId: note.id, direction: "raise" })
  expect(JSON.parse(sent[0] ?? "{}")).toEqual({
    type: "reorder_sticky_note",
    stickyNoteId: note.id,
    direction: "raise",
  })

  socket?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_reordered",
      revision: 2,
      stickyNote: { ...note, stackingOrder: 1 },
    }),
  })
  expect(reordered).toHaveLength(1)
  expect(reordered[0]).toMatchObject({
    type: "sticky_note_reordered",
    revision: 2,
    stickyNote: { id: note.id, stackingOrder: 1 },
  })
  connection.close()
})

test("Board client sends independent Position commands and delivers revisioned movement events", async () => {
  const credential = "m".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const sent: string[] = []
  let socket: BoardSocket | undefined
  const moved: unknown[] = []
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      socket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (data) => sent.push(data),
        close: () => undefined,
      }
      return socket
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: () => undefined,
    onError: (error) => {
      throw error
    },
    onClose: () => undefined,
    onStickyNoteMoved: (event) => moved.push(event),
  })
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "shared position",
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
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 1,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [note],
    }),
  })
  connection.send({ type: "move_sticky_note", stickyNoteId: note.id, direction: "right" })
  expect(JSON.parse(sent[0] ?? "{}")).toEqual({
    type: "move_sticky_note",
    stickyNoteId: note.id,
    direction: "right",
  })

  socket?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_moved",
      revision: 2,
      stickyNote: { ...note, position: { x: 1, y: 0 } },
    }),
  })
  expect(moved).toHaveLength(1)
  expect(moved[0]).toMatchObject({
    type: "sticky_note_moved",
    revision: 2,
    stickyNote: { id: note.id, position: { x: 1, y: 0 }, text: note.text },
  })
  connection.close()
})

test("Board client reconnects after a dropped socket and replaces state from the next authoritative snapshot", async () => {
  const credential = "e".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const sockets: BoardSocket[] = []
  const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = []
  const states: string[] = []
  const snapshots: number[] = []
  const receivedEvents: number[] = []

  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      const socket: BoardSocket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => undefined,
      }
      sockets.push(socket)
      return socket
    },
    {
      scheduler: {
        schedule(callback, delayMs) {
          const entry = { callback, delayMs, cancelled: false }
          scheduled.push(entry)
          return entry
        },
        cancel(handle) {
          ;(handle as { cancelled: boolean }).cancelled = true
        },
      },
      reconnectPolicy: (attempt) => attempt === 1 ? 25 : 50,
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: (snapshot) => snapshots.push(snapshot.revision),
    onError: (error) => {
      throw error
    },
    onClose: () => undefined,
    onConnectionState: (state) => states.push(state),
    onStickyNoteUpdated: (event) => receivedEvents.push(event.revision),
  })

  sockets[0]?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 4,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [],
    }),
  })
  expect(states.at(-1)).toBe("connected")

  // Revision 5 is intentionally dropped before the socket is lost.
  sockets[0]?.onclose?.()
  expect(states.at(-1)).toBe("reconnecting")
  expect(scheduled.map((entry) => entry.delayMs)).toEqual([25])

  const retry = scheduled[0]
  retry?.callback()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(sockets).toHaveLength(2)

  sockets[1]?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 6,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [],
    }),
  })
  sockets[1]?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_updated",
      revision: 7,
      stickyNote: {
        id: "Lm7u3nW8kM2pR5sT9vY4aB",
        text: "later",
        textVersion: 2,
        position: { x: 0, y: 0 },
        color: "yellow",
        stackingOrder: 0,
        authorship: { member: { username: "ada_lovelace" } },
        createdAt: "2026-08-10T00:00:00.000Z",
        lastEdit: {
          member: { username: "ada_lovelace" },
          at: "2026-08-10T00:00:01.000Z",
        },
      },
    }),
  })

  expect(snapshots).toEqual([4, 6])
  expect(receivedEvents).toEqual([7])
  expect(states.at(-1)).toBe("connected")

  // A callback from the old generation cannot append state to the replacement.
  sockets[0]?.onmessage?.({
    data: JSON.stringify({
      type: "sticky_note_updated",
      revision: 8,
      stickyNote: {
        id: "Lm7u3nW8kM2pR5sT9vY4aB",
        text: "stale old socket",
        textVersion: 3,
        position: { x: 0, y: 0 },
        color: "yellow",
        stackingOrder: 0,
        authorship: { member: { username: "ada_lovelace" } },
        createdAt: "2026-08-10T00:00:00.000Z",
        lastEdit: {
          member: { username: "ada_lovelace" },
          at: "2026-08-10T00:00:02.000Z",
        },
      },
    }),
  })
  expect(receivedEvents).toEqual([7])

  connection.close()
})

test("Board client buffers snapshot races and requests a snapshot instead of replaying across a revision gap", async () => {
  const credential = "f".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const note = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "authoritative",
    textVersion: 2,
    position: { x: 0, y: 0 },
    color: "yellow" as const,
    stackingOrder: 0,
    authorship: { member: { username: "ada_lovelace" } },
    createdAt: "2026-08-10T00:00:00.000Z",
    lastEdit: {
      member: { username: "ada_lovelace" },
      at: "2026-08-10T00:00:01.000Z",
    },
  }
  const sockets: BoardSocket[] = []
  const scheduled: Array<{ callback: () => void; delayMs: number }> = []
  const events: number[] = []
  const errors: string[] = []
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      const socket: BoardSocket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => undefined,
      }
      sockets.push(socket)
      return socket
    },
    {
      scheduler: {
        schedule(callback, delayMs) {
          const entry = { callback, delayMs }
          scheduled.push(entry)
          return entry
        },
        cancel: () => undefined,
      },
      reconnectPolicy: () => 1,
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: () => undefined,
    onError: (error) => errors.push(error.message),
    onClose: () => undefined,
    onStickyNoteUpdated: (event) => events.push(event.revision),
  })

  sockets[0]?.onmessage?.({
    data: JSON.stringify({ type: "sticky_note_updated", revision: 2, stickyNote: note }),
  })
  sockets[0]?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 1,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [],
    }),
  })
  expect(events).toEqual([2])

  // Revision 4 arrives while revision 3 is missing. It must not be applied or replayed.
  sockets[0]?.onmessage?.({
    data: JSON.stringify({ type: "sticky_note_updated", revision: 4, stickyNote: note }),
  })
  expect(events).toEqual([2])
  expect(errors.at(-1)).toContain("authoritative snapshot")
  expect(scheduled).toHaveLength(1)

  scheduled[0]?.callback()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(sockets).toHaveLength(2)

  // An event can race ahead of the replacement snapshot. It is only accepted after
  // the snapshot establishes the new revision, and an equal revision is discarded.
  sockets[1]?.onmessage?.({
    data: JSON.stringify({ type: "sticky_note_updated", revision: 3, stickyNote: note }),
  })
  sockets[1]?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 3,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [note],
    }),
  })
  expect(events).toEqual([2])
  sockets[1]?.onmessage?.({
    data: JSON.stringify({ type: "sticky_note_updated", revision: 4, stickyNote: note }),
  })
  expect(events).toEqual([2, 4])

  connection.close()
})

test("Board client exposes bounded retry states, resets backoff after a snapshot, and cancels retries on close", async () => {
  const credential = "g".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const sockets: BoardSocket[] = []
  const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = []
  const states: string[] = []
  let requestCount = 0
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => {
      requestCount += 1
      if (requestCount === 2) {
        return new Response(JSON.stringify({ error: "service unavailable" }), { status: 503 })
      }
      return new Response(JSON.stringify({ status: "ready" }), { status: 200 })
    },
    () => {
      const socket: BoardSocket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => undefined,
      }
      sockets.push(socket)
      return socket
    },
    {
      scheduler: {
        schedule(callback, delayMs) {
          const entry = { callback, delayMs, cancelled: false }
          scheduled.push(entry)
          return entry
        },
        cancel(handle) {
          ;(handle as { cancelled: boolean }).cancelled = true
        },
      },
      reconnectPolicy: (attempt) => attempt * 10,
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: () => undefined,
    onError: () => undefined,
    onClose: () => undefined,
    onConnectionState: (state) => states.push(state),
  })
  sockets[0]?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 1,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [],
    }),
  })
  sockets[0]?.onclose?.()
  expect(states.slice(-2)).toEqual(["connected", "reconnecting"])
  expect(scheduled.map((entry) => entry.delayMs)).toEqual([10])

  scheduled[0]?.callback()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(states.at(-1)).toBe("waking")
  expect(scheduled.map((entry) => entry.delayMs)).toEqual([10, 20])

  scheduled[1]?.callback()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(sockets).toHaveLength(2)
  sockets[1]?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 2,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [],
    }),
  })
  expect(states.at(-1)).toBe("connected")

  sockets[1]?.onclose?.()
  expect(scheduled.map((entry) => entry.delayMs)).toEqual([10, 20, 10])
  connection.close()
  expect(scheduled[2]?.cancelled).toBe(true)
  expect(states.at(-1)).toBe("closed")
})

test("Board client keeps a cold-start connection in waking state and retries the initial readiness check", async () => {
  const credential = "w".repeat(43)
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const sockets: BoardSocket[] = []
  const scheduled: Array<{ callback: () => void; delayMs: number }> = []
  const states: string[] = []
  let requestCount = 0
  const client = createBoardClient(
    "https://tuiscrib.test",
    async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ error: "service unavailable" }), { status: 503 })
      }
      return new Response(JSON.stringify({ status: "ready" }), { status: 200 })
    },
    () => {
      const socket: BoardSocket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => undefined,
      }
      sockets.push(socket)
      return socket
    },
    {
      scheduler: {
        schedule(callback, delayMs) {
          const entry = { callback, delayMs }
          scheduled.push(entry)
          return entry
        },
        cancel: () => undefined,
      },
      reconnectPolicy: () => 25,
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard(credential, boardId, {
    onSnapshot: () => undefined,
    onError: () => undefined,
    onClose: () => undefined,
    onConnectionState: (state) => states.push(state),
  })

  expect(states).toEqual(["connecting", "waking"])
  expect(scheduled.map((entry) => entry.delayMs)).toEqual([25])
  expect(() => connection.send({ type: "heartbeat" })).toThrow("not connected")

  scheduled[0]?.callback()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(sockets).toHaveLength(1)
  expect(states.at(-1)).toBe("reconnecting")

  sockets[0]?.onmessage?.({
    data: JSON.stringify({
      type: "snapshot",
      board: { id: boardId, name: "Ideas", role: "member" },
      revision: 0,
      presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
      stickyNotes: [],
    }),
  })
  expect(states.at(-1)).toBe("connected")
  connection.close()
})

test("Board client does not retry a non-transient initial HTTP failure", async () => {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = []
  const states: string[] = []
  const client = createBoardClient(
    "https://tuiscrib.test",
    async () => new Response(JSON.stringify({ error: "invalid Board request" }), { status: 400 }),
    () => {
      throw new Error("WebSocket should not be opened after an invalid HTTP request")
    },
    {
      scheduler: {
        schedule(callback, delayMs) {
          const entry = { callback, delayMs }
          scheduled.push(entry)
          return entry
        },
        cancel: () => undefined,
      },
      reconnectPolicy: () => 25,
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  await expect(openBoard("i".repeat(43), "Qx7u3nW8kM2pR5sT9vY4aB", {
    onSnapshot: () => undefined,
    onError: () => undefined,
    onClose: () => undefined,
    onConnectionState: (state) => states.push(state),
  })).rejects.toThrow("invalid Board request")

  expect(states).toEqual(["connecting", "unavailable"])
  expect(scheduled).toHaveLength(0)
})

test("Board client retries an initial WebSocket wakeup failure through the bounded scheduler", async () => {
  const boardId = "Qx7u3nW8kM2pR5sT9vY4aB"
  const scheduled: Array<{ callback: () => void; delayMs: number }> = []
  const sockets: BoardSocket[] = []
  let attempts = 0
  const states: string[] = []
  const client = createBoardClient(
    "https://tuiscrib.test",
    async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error("WebSocket wakeup failed")
      }
      const socket: BoardSocket = {
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => undefined,
        close: () => undefined,
      }
      sockets.push(socket)
      return socket
    },
    {
      scheduler: {
        schedule(callback, delayMs) {
          const entry = { callback, delayMs }
          scheduled.push(entry)
          return entry
        },
        cancel: () => undefined,
      },
      reconnectPolicy: () => 25,
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  const connection = await openBoard("j".repeat(43), boardId, {
    onSnapshot: () => undefined,
    onError: () => undefined,
    onClose: () => undefined,
    onConnectionState: (state) => states.push(state),
  })

  expect(states).toEqual(["connecting", "unavailable"])
  expect(scheduled.map((entry) => entry.delayMs)).toEqual([25])
  scheduled[0]?.callback()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(sockets).toHaveLength(1)
  expect(states.at(-1)).toBe("reconnecting")
  connection.close()
})

test("Board client distinguishes an unauthorized reconnect failure from an unavailable service", async () => {
  const states: string[] = []
  let error: Error | undefined
  const client = createBoardClient(
    "http://tuiscrib.test",
    async () => new Response(JSON.stringify({
      error: "Your Terminal Session is invalid. Sign in again.",
      code: "invalid_session",
    }), { status: 401 }),
    () => {
      throw new Error("WebSocket should not be opened for an unauthorized Session")
    },
  )
  const openBoard = client.openBoard
  if (!openBoard) {
    throw new Error("Board client does not support Board collaboration")
  }

  await expect(openBoard("h".repeat(43), "Qx7u3nW8kM2pR5sT9vY4aB", {
    onSnapshot: () => undefined,
    onError: (nextError) => { error = nextError },
    onClose: () => undefined,
    onConnectionState: (state) => states.push(state),
  })).rejects.toThrow("Your Terminal Session is invalid")

  expect(states).toEqual(["connecting", "unauthorized"])
  expect(error?.message).toBe("Your Terminal Session is invalid. Sign in again.")
})

test("bounded reconnect policy caps exponential retry delay", () => {
  const policy = createBoundedReconnectPolicy({
    initialDelayMs: 10,
    maximumDelayMs: 25,
    multiplier: 2,
  })

  expect([policy(1), policy(2), policy(3), policy(4)]).toEqual([10, 20, 25, 25])
})
