import { expect, test } from "bun:test"

import {
  createAuthClient,
  createBoardClient,
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
