import { afterAll, beforeAll, expect, test } from "bun:test"
import { act } from "react"

import type { BoardSummary } from "@tuiscrib/contracts"
import {
  createBoardClient,
  type BoardClient,
} from "@tuiscrib/terminal"

import {
  AcceptanceHarness,
  createMemoryCredentialStore,
  type TerminalClient,
} from "./harness.tsx"

let harness: AcceptanceHarness | null = null

beforeAll(async () => {
  harness = await AcceptanceHarness.start()
}, { timeout: 120_000 })

afterAll(async () => {
  await harness?.dispose()
}, { timeout: 30_000 })

test("opens one Board for two real terminal clients and renders Presence lifecycle", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }

  const ownerCredential = await registerUser("presence_owner")
  const memberCredential = await registerUser("presence_member")
  const outsiderCredential = await registerUser("presence_outsider")

  const created = await requestJson<{ board: BoardSummary; joinCode: string }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Presence Board" }),
    },
  )
  expect(created.status).toBe(201)
  const createdBody = created.body

  const joined = await requestJson<{ board: BoardSummary }>(
    "/boards/join",
    memberCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: createdBody.joinCode }),
    },
  )
  expect(joined.status).toBe(201)
  expect(joined.body.board.id).toBe(createdBody.board.id)

  const owner = await harness.addShellClient(
    "presence-owner",
    createMemoryCredentialStore(ownerCredential, "memory://presence/owner"),
  )
  const member = await harness.addShellClient(
    "presence-member",
    createMemoryCredentialStore(memberCredential, "memory://presence/member"),
  )

  await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
  await waitForFrame(member, (frame) => frame.includes("Terminal Session restored"))

  await openSelectedBoard(owner, createdBody.board.name)
  const ownerFirst = await waitForFrame(
    owner,
    (frame) => frame.includes("Board: Presence Board") && frame.includes("presence_owner · viewing"),
  )
  expect(ownerFirst).toContain("MODE  NAVIGATE")
  expect(ownerFirst).toContain("Navigate mode · cursor at the stable origin")
  expect(ownerFirst).toContain("Board revision: 0")
  expect(ownerFirst).toContain("Viewing Presence")
  expect(count(ownerFirst, "presence_owner · viewing")).toBe(1)
  expect(ownerFirst).not.toContain("presence_member · viewing")

  await openSelectedBoard(member, createdBody.board.name)
  const memberFirst = await waitForFrame(
    member,
    (frame) =>
      frame.includes("presence_owner · viewing") && frame.includes("presence_member · viewing"),
  )
  expect(memberFirst).toContain("Board revision: 0")
  expect(memberFirst).toContain("Navigate mode · cursor at the stable origin")
  expect(count(memberFirst, "presence_owner · viewing")).toBe(1)
  expect(count(memberFirst, "presence_member · viewing")).toBe(1)

  const ownerWithMember = await waitForFrame(
    owner,
    (frame) =>
      frame.includes("presence_owner · viewing") && frame.includes("presence_member · viewing"),
  )
  expect(count(ownerWithMember, "presence_owner · viewing")).toBe(1)
  expect(count(ownerWithMember, "presence_member · viewing")).toBe(1)

  await harness.disposeClient(member)
  const ownerAfterDisconnect = await waitForFrame(
    owner,
    (frame) => frame.includes("presence_owner · viewing") && !frame.includes("presence_member · viewing"),
  )
  expect(count(ownerAfterDisconnect, "presence_owner · viewing")).toBe(1)
  expect(ownerAfterDisconnect).not.toContain("presence_member · viewing")

  const unauthorized = await requestJson<unknown>(
    `/boards/${createdBody.board.id}/collaboration`,
    outsiderCredential,
  )
  const nonexistent = await requestJson<unknown>(
    `/boards/${"Z".repeat(22)}/collaboration`,
    outsiderCredential,
  )
  expect(unauthorized.status).toBe(404)
  expect(nonexistent.status).toBe(404)
  expect(unauthorized.body).toEqual(nonexistent.body)
  expect(JSON.stringify(unauthorized.body)).not.toContain("Presence Board")
  expect(JSON.stringify(unauthorized.body)).not.toContain("revision")
  expect(JSON.stringify(unauthorized.body)).not.toContain("presence")

  const unauthorizedClient = await addErrorClient(
    "presence-unauthorized",
    outsiderCredential,
    createdBody.board.id,
    "Private Board placeholder",
  )
  const unauthorizedFrame = await waitForFrame(
    unauthorizedClient,
    (frame) => frame.includes("Error: Board Membership was not found."),
  )
  expect(unauthorizedFrame).toContain("Error: Board Membership was not found.")

  const nonexistentClient = await addErrorClient(
    "presence-nonexistent",
    outsiderCredential,
    "Z".repeat(22),
    "Missing Board placeholder",
  )
  const nonexistentFrame = await waitForFrame(
    nonexistentClient,
    (frame) => frame.includes("Error: Board Membership was not found."),
  )
  expect(nonexistentFrame).toContain("Error: Board Membership was not found.")

  await harness.disposeClient(owner)
  await harness.disposeClient(unauthorizedClient)
  await harness.disposeClient(nonexistentClient)

  async function addErrorClient(
    label: string,
    credential: string,
    boardId: string,
    name: string,
  ): Promise<TerminalClient> {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    const listedBoard: BoardSummary = { id: boardId, name, role: "member" }
    const realClient = createBoardClient(harness.baseUrl)
    const boardClient: BoardClient = {
      ...realClient,
      listBoards: async () => ({ boards: [listedBoard] }),
    }
    const client = await harness.addShellClient(
      label,
      createMemoryCredentialStore(credential, `memory://${label}/session`),
      boardClient,
    )
    await waitForFrame(client, (frame) => frame.includes("Terminal Session restored"))
    await openSelectedBoard(client, name)
    return client
  }

  async function openSelectedBoard(client: TerminalClient, boardName: string): Promise<void> {
    await act(async () => {
      client.setup.mockInput.pressKey("b")
      await client.setup.renderOnce()
    })
    await waitForFrame(client, (frame) => frame.includes("Board list") && frame.includes(boardName))
    await act(async () => {
      client.setup.mockInput.pressKey("o")
      await client.setup.renderOnce()
    })
  }

  async function registerUser(username: string): Promise<string> {
    const response = await fetch(`${harness?.baseUrl}/auth/register`, {
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

  async function requestJson<T>(
    path: string,
    credential: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${harness?.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${credential}`,
        ...init.headers,
      },
    })
    return { status: response.status, body: await response.json() as T }
  }

  function count(value: string, needle: string): number {
    return value.split(needle).length - 1
  }

  async function waitForFrame(
    client: TerminalClient,
    predicate: (frame: string) => boolean,
  ): Promise<string> {
    let lastFrame = ""
    let matchedFrame: string | undefined
    await act(async () => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
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
})
