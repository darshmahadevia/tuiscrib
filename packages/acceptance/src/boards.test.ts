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
