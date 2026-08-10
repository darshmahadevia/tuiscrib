import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { act } from "react"

import { AcceptanceHarness, type TerminalClient } from "./harness.tsx"
import type { CredentialStore } from "@tuiscrib/terminal"

describe("Tuiscrib Board administration", () => {
  let harness: AcceptanceHarness | null = null
  let credential = ""

  beforeAll(async () => {
    harness = await AcceptanceHarness.start()
    const response = await fetch(`${harness.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "board_owner",
        password: "correct horse",
        confirmation: "correct horse",
      }),
    })
    expect(response.status).toBe(201)
    const body = await response.json() as { sessionCredential: string }
    credential = body.sessionCredential
  }, { timeout: 120_000 })

  afterAll(async () => {
    await harness?.dispose()
  }, { timeout: 30_000 })

  function createBoard(name: string) {
    return fetch(`${harness?.baseUrl}/boards`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name }),
    })
  }

  async function registerUser(username: string): Promise<string> {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    const response = await fetch(`${harness.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        password: "correct horse",
        confirmation: "correct horse",
      }),
    })
    expect(response.status).toBe(201)
    return (await response.json() as { sessionCredential: string }).sessionCredential
  }

  async function listBoardsFor(credential: string): Promise<{ boards: unknown[] }> {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    const response = await fetch(`${harness.baseUrl}/boards`, {
      headers: { authorization: `Bearer ${credential}` },
    })
    expect(response.status).toBe(200)
    return await response.json() as { boards: unknown[] }
  }

  async function waitForFrame(
    client: TerminalClient,
    predicate: (frame: string) => boolean,
  ): Promise<string> {
    let lastFrame = ""
    let matchedFrame: string | undefined
    await act(async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await Bun.sleep(5)
        await client.setup.renderOnce()
        lastFrame = client.setup.captureCharFrame()
        if (predicate(lastFrame)) {
          matchedFrame = lastFrame
          return
        }
      }
    })
    if (matchedFrame !== undefined) {
      return matchedFrame
    }
    throw new Error(`Timed out waiting for ${client.label} rendered frame\n${lastFrame}`)
  }

  test("joins, leaves, and rejoins a Board through public HTTP", async () => {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    const ownerCredential = await registerUser("join_slice_owner")
    const memberCredential = await registerUser("join_slice_member")
    const created = await fetch(`${harness.baseUrl}/boards`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Join Slice" }),
    })
    expect(created.status).toBe(201)
    const createdBody = await created.json() as {
      board: { id: string; name: string; role: string }
      joinCode: string
    }

    expect(await listBoardsFor(memberCredential)).toEqual({ boards: [] })

    const joined = await fetch(`${harness.baseUrl}/boards/join`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${memberCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ joinCode: createdBody.joinCode.toLowerCase() }),
    })
    expect(joined.status).toBe(201)
    expect(await joined.json()).toEqual({
      board: {
        id: createdBody.board.id,
        name: createdBody.board.name,
        role: "member",
      },
    })
    expect(await listBoardsFor(memberCredential)).toEqual({
      boards: [{ ...createdBody.board, role: "member" }],
    })

    const left = await fetch(`${harness.baseUrl}/boards/${createdBody.board.id}/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberCredential}` },
    })
    expect(left.status).toBe(200)
    expect(await left.json()).toEqual({ status: "left" })
    expect(await listBoardsFor(memberCredential)).toEqual({ boards: [] })

    const rejoined = await fetch(`${harness.baseUrl}/boards/join`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${memberCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ joinCode: createdBody.joinCode }),
    })
    expect(rejoined.status).toBe(201)
    expect(await listBoardsFor(memberCredential)).toEqual({
      boards: [{ ...createdBody.board, role: "member" }],
    })
  })

  test("serializes the 25-Membership limit, preserves the Join Code, and protects the Owner", async () => {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }
    const baseUrl = harness.baseUrl

    const ownerCredential = await registerUser("capacity_owner")
    const created = await fetch(`${harness.baseUrl}/boards`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Capacity Slice" }),
    })
    expect(created.status).toBe(201)
    const createdBody = await created.json() as {
      board: { id: string; name: string; role: string }
      joinCode: string
    }

    const memberCredentials = await Promise.all(
      Array.from({ length: 25 }, (_, index) => registerUser(`capacity_member_${index}`)),
    )
    const joinResults = await Promise.all(
      memberCredentials.map(async (credential, index) => {
        const response = await fetch(`${baseUrl}/boards/join`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
            "x-forwarded-for": `198.51.100.${index + 1}`,
          },
          body: JSON.stringify({ joinCode: createdBody.joinCode }),
        })
        return { index, status: response.status, body: await response.text() }
      }),
    )

    expect(joinResults.filter(({ status }) => status === 201)).toHaveLength(24)
    const rejected = joinResults.filter(({ status }) => status === 409)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.body).not.toContain(createdBody.joinCode)

    const rejectedIndex = rejected[0]?.index
    if (rejectedIndex === undefined) {
      throw new Error("capacity test did not produce a rejected Member")
    }
    const successfulIndex = joinResults.find(({ status }) => status === 201)?.index
    if (successfulIndex === undefined) {
      throw new Error("capacity test did not produce a successful Member")
    }

    const left = await fetch(`${harness.baseUrl}/boards/${createdBody.board.id}/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberCredentials[successfulIndex]}` },
    })
    expect(left.status).toBe(200)

    const retry = await fetch(`${harness.baseUrl}/boards/join`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${memberCredentials[rejectedIndex]}`,
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.250",
      },
      body: JSON.stringify({ joinCode: createdBody.joinCode }),
    })
    expect(retry.status).toBe(201)
    expect(await listBoardsFor(memberCredentials[rejectedIndex])).toEqual({
      boards: [{ ...createdBody.board, role: "member" }],
    })

    const ownerLeave = await fetch(`${harness.baseUrl}/boards/${createdBody.board.id}/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerCredential}` },
    })
    expect(ownerLeave.status).toBe(409)
    expect(await ownerLeave.text()).not.toContain(createdBody.joinCode)
    expect(await listBoardsFor(ownerCredential)).toEqual({
      boards: [{ ...createdBody.board, role: "owner" }],
    })
  })

  test("rejects an invalid Join Code without disclosing the private Board", async () => {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    const ownerCredential = await registerUser("privacy_owner")
    const memberCredential = await registerUser("privacy_member")
    const created = await fetch(`${harness.baseUrl}/boards`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Private Slice" }),
    })
    expect(created.status).toBe(201)
    const createdBody = await created.json() as {
      board: { name: string }
      joinCode: string
    }
    const invalidJoinCode = `${createdBody.joinCode.slice(0, -1)}${
      createdBody.joinCode.endsWith("2") ? "3" : "2"
    }`

    const response = await fetch(`${harness.baseUrl}/boards/join`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${memberCredential}`,
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.251",
      },
      body: JSON.stringify({ joinCode: invalidJoinCode }),
    })
    const body = await response.text()

    expect(response.status).toBe(404)
    expect(body).not.toContain(invalidJoinCode)
    expect(body).not.toContain(createdBody.board.name)
    expect(await listBoardsFor(memberCredential)).toEqual({ boards: [] })
  })

  test("creates duplicate-named Boards, discloses a grouped Join Code once, and filters Memberships", async () => {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    const first = await createBoard("  Ideas  ")
    expect(first.status).toBe(201)
    const firstBody = await first.json() as {
      board: { id: string; name: string; role: string }
      joinCode: string
    }
    expect(firstBody.board.name).toBe("Ideas")
    expect(firstBody.board.role).toBe("owner")
    expect(firstBody.joinCode).toMatch(/^(?:[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-){6}[23456789ABCDEFGHJKMNPQRSTVWXYZ]{2}$/)

    const second = await createBoard("Ideas")
    expect(second.status).toBe(201)
    const secondBody = await second.json() as {
      board: { id: string; name: string; role: string }
      joinCode: string
    }
    expect(secondBody.board.id).not.toBe(firstBody.board.id)
    expect(secondBody.joinCode).not.toBe(firstBody.joinCode)

    const all = await fetch(`${harness.baseUrl}/boards`, {
      headers: { authorization: `Bearer ${credential}` },
    })
    expect(all.status).toBe(200)
    const allText = await all.text()
    expect(allText).toContain('"name":"Ideas"')
    expect(allText).toContain('"role":"owner"')
    expect(allText).not.toContain(firstBody.joinCode)
    expect(allText).not.toContain(secondBody.joinCode)

    const filtered = await fetch(`${harness.baseUrl}/boards?filter=ideas`, {
      headers: { authorization: `Bearer ${credential}` },
    })
    expect(filtered.status).toBe(200)
    expect((await filtered.json() as { boards: unknown[] }).boards).toHaveLength(2)
  })

  test("accepts only one concurrent creation for the final owned-Board slot", async () => {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    for (let index = 3; index <= 19; index += 1) {
      expect((await createBoard(`Board ${index}`)).status).toBe(201)
    }

    const concurrent = await Promise.all([
      createBoard("Concurrent A"),
      createBoard("Concurrent B"),
    ])
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409])

    const overLimit = await createBoard("Twenty First")
    expect(overLimit.status).toBe(409)
    expect(await overLimit.json()).toEqual({
      error: "A User may own at most 20 Boards.",
      code: "owned_board_limit",
    })

    const listed = await fetch(`${harness.baseUrl}/boards`, {
      headers: { authorization: `Bearer ${credential}` },
    })
    expect((await listed.json() as { boards: unknown[] }).boards).toHaveLength(20)
  })

  test("renders Board creation, one-time Join Code disclosure, filtering, and the ownership limit", async () => {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    const registration = await fetch(`${harness.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "board_terminal",
        password: "correct horse",
        confirmation: "correct horse",
      }),
    })
    expect(registration.status).toBe(201)
    const uiCredential = (await registration.json() as { sessionCredential: string }).sessionCredential
    const credentialStore: CredentialStore = {
      filePath: "memory://board-terminal/session",
      load: async () => uiCredential,
      save: async () => undefined,
      remove: async () => undefined,
    }
    const client = await harness.addShellClient("board-terminal", credentialStore)
    await waitForFrame(client, (frame) => frame.includes("Terminal Session restored"))

    await act(async () => {
      client.setup.mockInput.pressKey("b")
      await client.setup.renderOnce()
    })
    await waitForFrame(client, (frame) => frame.includes("Board list"))

    await act(async () => {
      client.setup.mockInput.pressKey("c")
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("  Projet  ")
      client.setup.mockInput.pressEnter()
      await client.setup.renderOnce()
    })
    const createdFrame = await waitForFrame(
      client,
      (frame) => frame.includes("Initial Join Code (shown once):"),
    )
    const joinCode = createdFrame.match(
      /Initial Join Code \(shown once\): ((?:[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-){6}[23456789ABCDEFGHJKMNPQRSTVWXYZ]{2})/,
    )?.[1]
    expect(joinCode).toBeDefined()
    expect(createdFrame).toContain("Projet")
    expect(createdFrame).toContain("Owner")

    await act(async () => {
      client.setup.mockInput.pressKey("f")
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("projet")
      client.setup.mockInput.pressEnter()
      await client.setup.renderOnce()
    })
    const filteredFrame = await waitForFrame(client, (frame) => frame.includes("Filter: projet"))
    expect(filteredFrame).toContain("Projet")
    expect(filteredFrame).not.toContain(joinCode ?? "")

    for (let index = 2; index <= 20; index += 1) {
      expect((await fetch(`${harness.baseUrl}/boards`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${uiCredential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: `Quota ${index}` }),
      })).status).toBe(201)
    }

    await act(async () => {
      client.setup.mockInput.pressKey("c")
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("Rejected")
      client.setup.mockInput.pressEnter()
      await client.setup.renderOnce()
    })
    const limitFrame = await waitForFrame(client, (frame) => frame.includes("at most 20"))
    expect(limitFrame).not.toContain("Initial Join Code")
  }, 60_000)
})
