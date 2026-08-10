import { afterAll, beforeAll, expect, test } from "bun:test"
import { act } from "react"

import { MAX_STICKY_NOTE_CHARACTERS, type BoardSummary } from "@tuiscrib/contracts"
import { STICKY_NOTE_TEXT_DEBOUNCE_MS } from "@tuiscrib/terminal"

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

test("renders one durable Sticky Note and its attribution in two live terminals", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }
  const ownerCredential = await registerUser("sticky_owner")
  const memberCredential = await registerUser("sticky_member")
  const created = await requestJson<{ board: BoardSummary; joinCode: string }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sticky Notes Board" }),
    },
  )
  expect(created.status).toBe(201)

  const joined = await requestJson<{ board: BoardSummary }>(
    "/boards/join",
    memberCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: created.body.joinCode }),
    },
  )
  expect(joined.status).toBe(201)

  const owner = await harness.addShellClient(
    "sticky-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/owner"),
    undefined,
    {
      schedule: (callback, delayMs) => harness?.clock.setTimeout(callback, delayMs),
      cancel: (handle) => harness?.clock.clearTimeout(handle as number),
    },
  )
  const member = await harness.addShellClient(
    "sticky-member",
    createMemoryCredentialStore(memberCredential, "memory://sticky/member"),
  )

  await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
  await waitForFrame(member, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(owner, created.body.board.name)
  await openSelectedBoard(member, created.body.board.name)
  await waitForFrame(
    owner,
    (frame) => frame.includes("sticky_owner · viewing") && frame.includes("sticky_member · viewing"),
  )
  await waitForFrame(
    member,
    (frame) => frame.includes("sticky_owner · viewing") && frame.includes("sticky_member · viewing"),
  )

  await act(async () => {
    owner.setup.mockInput.pressKey("n")
    await owner.setup.renderOnce()
  })
  const provisional = await waitForFrame(
    owner,
    (frame) => frame.includes("Provisional Sticky Note") && frame.includes("authority") && frame.includes("granted"),
  )
  expect(provisional).toContain("sticky_owner · creating")
  expect(provisional).toContain("Color yellow")

  await act(async () => {
    await owner.setup.mockInput.typeText("durable first note")
    await owner.setup.renderOnce()
  })
  expect(owner.setup.captureCharFrame()).toContain("Sticky Notes: 0")
  await act(async () => {
    harness?.clock.advance(STICKY_NOTE_TEXT_DEBOUNCE_MS)
    await owner.setup.renderOnce()
  })

  const ownerFrame = await waitForFrame(
    owner,
    (frame) => frame.includes("durable first note") && frame.includes("Authored by sticky_owner"),
  )
  expect(ownerFrame).toContain("Sticky Note")
  expect(ownerFrame).toContain("sticky_owner · editing")
  expect(ownerFrame).toContain("Last edit by sticky_owner")

  const memberFrame = await waitForFrame(
    member,
    (frame) => frame.includes("durable first note") && frame.includes("Authored by sticky_owner"),
  )
  expect(memberFrame).toContain("Sticky Notes: 1")
  expect(memberFrame).toContain("sticky_owner · editing")
  expect(memberFrame).toContain("Board revision: 1")
})

test("discards an empty provisional Sticky Note and transitions Presence back to viewing", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }

  const ownerCredential = await registerUser("empty_owner")
  const memberCredential = await registerUser("empty_member")
  const created = await requestJson<{ board: BoardSummary; joinCode: string }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Empty Provisional Board" }),
    },
  )
  const joined = await requestJson<{ board: BoardSummary }>(
    "/boards/join",
    memberCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: created.body.joinCode }),
    },
  )
  expect(created.status).toBe(201)
  expect(joined.status).toBe(201)

  const owner = await harness.addShellClient(
    "empty-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/empty-owner"),
  )
  const member = await harness.addShellClient(
    "empty-member",
    createMemoryCredentialStore(memberCredential, "memory://sticky/empty-member"),
  )
  await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
  await waitForFrame(member, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(owner, created.body.board.name)
  await openSelectedBoard(member, created.body.board.name)
  await waitForFrame(owner, (frame) => frame.includes("empty_owner · viewing") && frame.includes("Sticky Notes: 0"))

  await act(async () => {
    owner.setup.mockInput.pressKey("n")
    await owner.setup.renderOnce()
  })
  await waitForFrame(owner, (frame) => frame.includes("empty_owner · creating") && frame.includes("Sticky Notes: 0"))

  await act(async () => {
    owner.setup.mockInput.pressEscape()
    await owner.setup.renderOnce()
  })
  const discarded = await waitForFrame(
    member,
    (frame) => frame.includes("empty_owner · viewing") && frame.includes("Sticky Notes: 0"),
  )
  expect(discarded).toContain("Board revision: 0")
})

test("renders a clear editor error and rejects text beyond 2,000 user-perceived characters", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }

  const ownerCredential = await registerUser("limit_owner")
  const created = await requestJson<{ board: BoardSummary }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Text Limit Board" }),
    },
  )
  expect(created.status).toBe(201)

  const owner = await harness.addShellClient(
    "limit-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/limit-owner"),
    undefined,
    {
      schedule: (callback, delayMs) => harness?.clock.setTimeout(callback, delayMs),
      cancel: (handle) => harness?.clock.clearTimeout(handle as number),
    },
  )
  await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(owner, created.body.board.name)
  await waitForFrame(owner, (frame) => frame.includes("limit_owner · viewing"))

  await act(async () => {
    owner.setup.mockInput.pressKey("n")
    await owner.setup.renderOnce()
  })
  await waitForFrame(
    owner,
    (frame) =>
      frame.includes("limit_owner · creating") &&
      frame.includes("Provisional Sticky Note") &&
      frame.includes("authority") &&
      frame.includes("granted"),
  )
  const overLimitText = "e\u0301".repeat(MAX_STICKY_NOTE_CHARACTERS + 1)
  await act(async () => {
    await owner.setup.mockInput.pasteBracketedText(overLimitText)
    await owner.setup.renderOnce()
  })
  const rejected = await waitForFrame(
    owner,
    (frame) => frame.includes("2,000 user-perceived Unicode characters"),
  )
  expect(rejected).toContain("Sticky Notes: 0")

  await act(async () => {
    owner.setup.mockInput.pressEscape()
    await owner.setup.renderOnce()
  })
  const afterDiscard = await waitForFrame(
    owner,
    (frame) => frame.includes("Sticky Notes: 0") && frame.includes("Board revision: 0"),
  )
  expect(afterDiscard).not.toContain("Sticky Note ·")
})

test("restarting the hosted service cannot orphan an empty provisional Sticky Note", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }
  const activeHarness = harness

  const ownerCredential = await registerUser("restart_owner")
  const created = await requestJson<{ board: BoardSummary }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Restart Provisional Board" }),
    },
  )
  expect(created.status).toBe(201)

  const owner = await harness.addShellClient(
    "restart-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/restart-owner"),
  )
  await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(owner, created.body.board.name)
  await waitForFrame(owner, (frame) => frame.includes("restart_owner · viewing"))
  await act(async () => {
    owner.setup.mockInput.pressKey("n")
    await owner.setup.renderOnce()
  })
  await waitForFrame(owner, (frame) => frame.includes("restart_owner · creating"))

  await act(async () => {
    await activeHarness.restartService()
    await activeHarness.disposeClient(owner)
  })

  const reopened = await harness.addShellClient(
    "restart-owner-reopened",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/restart-owner-reopened"),
  )
  await waitForFrame(reopened, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(reopened, created.body.board.name)
  const snapshot = await waitForFrame(
    reopened,
    (frame) => frame.includes("Board revision: 0") && frame.includes("Sticky Notes: 0"),
  )
  expect(snapshot).not.toContain("Provisional Sticky Note")
})

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

async function waitForFrame(
  client: TerminalClient,
  predicate: (frame: string) => boolean,
): Promise<string> {
  let lastFrame = ""
  let matchedFrame: string | undefined
  await act(async () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
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

async function requestJson<T>(
  path: string,
  credential: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }
  const response = await fetch(`${harness.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${credential}`,
      ...init.headers,
    },
  })
  return { status: response.status, body: await response.json() as T }
}
