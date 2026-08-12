import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import type { BoardSnapshot } from "@tuiscrib/contracts"
import {
  type AuthClient,
  type BoardClient,
  type BoardConnectionHandlers,
  type CredentialStore,
  TerminalShell,
} from "@tuiscrib/terminal"

let activeSetup: Awaited<ReturnType<typeof testRender>> | null = null

afterEach(async () => {
  await act(async () => {
    activeSetup?.renderer.destroy()
  })
  activeSetup = null
})

test("renders the canvas as a large Select-first surface at multiple terminal sizes", async () => {
  for (const dimensions of [
    { width: 80, height: 24 },
    { width: 100, height: 30 },
  ]) {
    const fixture = createBoardFixture()
    activeSetup = await renderCanvas(dimensions, fixture.boardClient)

    let frame = activeSetup.captureCharFrame()
    expect(frame).toContain("Canvas Board · Connected · 1 online · Space actions")
    const actionsSpan = activeSetup.captureSpans().lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes("Space actions"))
    expect(actionsSpan?.bg.toInts()).toEqual([145, 205, 247, 255])
    expect(frame).toContain("origin note")
    expect(frame).not.toContain("hjkl")

    await pressKey("tab")
    frame = activeSetup.captureCharFrame()
    expect(frame).toContain("Canvas Board · Connected · 1 online · Space actions")

    await pressKey("right")
    frame = activeSetup.captureCharFrame()
    expect(frame).toContain("Canvas Board · Connected · 1 online · Space actions")
    expect(fixture.sent).toEqual([])

    await act(async () => {
      activeSetup?.renderer.destroy()
    })
    activeSetup = null
  }

  async function pressKey(key: "right" | "tab"): Promise<void> {
    if (!activeSetup) {
      throw new Error("terminal renderer did not start")
    }
    const setup = activeSetup
    await act(async () => {
      if (key === "right") setup.mockInput.pressArrow("right")
      else setup.mockInput.pressTab()
      await setup.renderOnce()
    })
  }
})

test("types Sticky Note bodies in entry order", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("Requesting Edit Claim")

  const note = createSnapshot(3).stickyNotes?.[0]
  if (!note) {
    throw new Error("typing fixture did not contain a Sticky Note")
  }
  await act(async () => {
    fixture.handlers?.onStickyNoteEditClaimGranted?.({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      claimId: "00000000-0000-4000-8000-000000000021",
      stickyNote: note,
    })
    await activeSetup?.renderOnce()
  })

  await act(async () => {
    for (const character of "abc") {
      activeSetup?.mockInput.pressKey(character)
      await activeSetup?.renderOnce()
    }
  })

  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("origin noteabc")
  expect(frame).not.toContain("cba")
})

test("saves an edited Sticky Note with a raw Ctrl+Enter", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient, "Canvas Board", false)

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  const note = createSnapshot(3).stickyNotes?.[0]
  if (!note) {
    throw new Error("raw Ctrl+Enter fixture did not contain a Sticky Note")
  }
  await act(async () => {
    fixture.handlers?.onStickyNoteEditClaimGranted?.({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      claimId: "00000000-0000-4000-8000-000000000023",
      stickyNote: note,
    })
    await activeSetup?.renderOnce()
    await activeSetup?.mockInput.typeText(" saved")
    await activeSetup?.renderOnce()
  })

  await act(async () => {
    activeSetup?.mockInput.pressKey("LINEFEED", { ctrl: true })
    await activeSetup?.renderOnce()
  })

  expect(JSON.parse(fixture.sent.at(-1) ?? "{}")).toMatchObject({
    type: "publish_sticky_note_edit",
    text: "origin note saved",
  })
  expect(activeSetup.captureCharFrame()).toContain("Saving Sticky Note")
})

test("saves an edited Sticky Note when Ctrl+Enter falls back to plain CR", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient, "Canvas Board", false)

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  const note = createSnapshot(3).stickyNotes?.[0]
  if (!note) {
    throw new Error("plain CR fixture did not contain a Sticky Note")
  }
  await act(async () => {
    fixture.handlers?.onStickyNoteEditClaimGranted?.({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      claimId: "00000000-0000-4000-8000-000000000025",
      stickyNote: note,
    })
    await activeSetup?.renderOnce()
    await activeSetup?.mockInput.typeText(" saved")
    await activeSetup?.renderOnce()
  })

  await act(async () => {
    // Some terminals collapse Ctrl+Enter to the same CR byte as Enter.
    activeSetup?.mockInput.pressEnter({ ctrl: true })
    await activeSetup?.renderOnce()
  })

  expect(JSON.parse(fixture.sent.at(-1) ?? "{}")).toMatchObject({
    type: "publish_sticky_note_edit",
    text: "origin note saved",
  })
})

test("keeps Ctrl+Enter routed to a visible editor after a Board snapshot", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  const note = createSnapshot(3).stickyNotes?.[0]
  if (!note) {
    throw new Error("snapshot routing fixture did not contain a Sticky Note")
  }
  await act(async () => {
    fixture.handlers?.onStickyNoteEditClaimGranted?.({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      claimId: "00000000-0000-4000-8000-000000000026",
      stickyNote: note,
    })
    await activeSetup?.renderOnce()
    await activeSetup?.mockInput.typeText(" saved")
    fixture.handlers?.onSnapshot(createSnapshot(4))
    await activeSetup?.renderOnce()
  })

  expect(activeSetup.captureCharFrame()).toContain("Edit Sticky Note")
  await act(async () => {
    activeSetup?.mockInput.pressKey("LINEFEED", { ctrl: true })
    await activeSetup?.renderOnce()
  })

  expect(JSON.parse(fixture.sent.at(-1) ?? "{}")).toMatchObject({
    type: "publish_sticky_note_edit",
    text: "origin note saved",
  })
})

test("returns Escape from a visible editor to the canvas after a Board snapshot", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  const note = createSnapshot(3).stickyNotes?.[0]
  if (!note) {
    throw new Error("snapshot Escape fixture did not contain a Sticky Note")
  }
  await act(async () => {
    fixture.handlers?.onStickyNoteEditClaimGranted?.({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      claimId: "00000000-0000-4000-8000-000000000027",
      stickyNote: note,
    })
    await activeSetup?.renderOnce()
    fixture.handlers?.onSnapshot(createSnapshot(4))
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
  })

  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Canvas Board · Connected")
  expect(frame).not.toContain("Edit Sticky Note")
  expect(frame).not.toContain("Welcome to Tuiscrib")
})

test("queues a new Sticky Note save until creation authority arrives", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient, "Canvas Board", false)

  await act(async () => {
    activeSetup?.mockInput.pressTab()
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
    await activeSetup?.mockInput.typeText("queued note")
    await activeSetup?.renderOnce()
  })
  const begin = JSON.parse(fixture.sent.at(-1) ?? "{}") as { provisionalId?: string; position?: { x: number; y: number }; color?: string }
  if (!begin.provisionalId || !begin.position || !begin.color) {
    throw new Error("queued save fixture did not send a creation claim request")
  }

  await act(async () => {
    activeSetup?.mockInput.pressEnter({ ctrl: true })
    await activeSetup?.renderOnce()
  })

  await act(async () => {
    fixture.handlers?.onStickyNoteCreationClaimGranted?.({
      type: "sticky_note_creation_claim_granted",
      provisionalId: begin.provisionalId!,
      claimId: "00000000-0000-4000-8000-000000000026",
      position: begin.position!,
      color: begin.color as "amber",
    })
    await activeSetup?.renderOnce()
  })

  expect(JSON.parse(fixture.sent.at(-1) ?? "{}")).toMatchObject({
    type: "publish_sticky_note",
    text: "queued note",
  })
})

test("queues an existing Sticky Note save until the Edit Claim arrives", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient, "Canvas Board", false)

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
    await activeSetup?.mockInput.typeText(" saved")
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEnter({ ctrl: true })
    await activeSetup?.renderOnce()
  })

  const note = createSnapshot(3).stickyNotes?.[0]
  if (!note) {
    throw new Error("queued edit fixture did not contain a Sticky Note")
  }
  await act(async () => {
    fixture.handlers?.onStickyNoteEditClaimGranted?.({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      claimId: "00000000-0000-4000-8000-000000000027",
      stickyNote: note,
    })
    await activeSetup?.renderOnce()
  })

  expect(JSON.parse(fixture.sent.at(-1) ?? "{}")).toMatchObject({
    type: "publish_sticky_note_edit",
    text: "origin note saved",
  })
})

test("Escape from a dirty Sticky Note edit returns to the canvas", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  const note = createSnapshot(3).stickyNotes?.[0]
  if (!note) {
    throw new Error("Escape fixture did not contain a Sticky Note")
  }
  await act(async () => {
    fixture.handlers?.onStickyNoteEditClaimGranted?.({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      claimId: "00000000-0000-4000-8000-000000000024",
      stickyNote: note,
    })
    await activeSetup?.renderOnce()
    await activeSetup?.mockInput.typeText(" changed")
    await activeSetup?.renderOnce()
  })

  await act(async () => {
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
  })

  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Canvas Board · Connected")
  expect(frame).not.toContain("Welcome to Tuiscrib")
  expect(frame).not.toContain("Boards")
})

test("Escape from a new Sticky Note draft returns to the canvas", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressTab()
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
    await activeSetup?.mockInput.typeText("discard me")
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
  })

  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Canvas Board · Connected")
  expect(frame).not.toContain("Welcome to Tuiscrib")
  expect(frame).not.toContain("Boards")
})

test("types a new Sticky Note body from left to right", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressTab()
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("Requesting Sticky Note creation authority")

  const begin = JSON.parse(fixture.sent.at(-1) ?? "{}") as {
    provisionalId?: string
    position?: { x: number; y: number }
    color?: "amber" | "blue" | "cyan" | "green" | "magenta" | "red" | "violet" | "yellow"
  }
  const provisionalId = begin.provisionalId
  const position = begin.position
  const color = begin.color
  if (!provisionalId || !position || !color) {
    throw new Error("typing fixture did not send a creation claim request")
  }
  await act(async () => {
    fixture.handlers?.onStickyNoteCreationClaimGranted?.({
      type: "sticky_note_creation_claim_granted",
      provisionalId,
      claimId: "00000000-0000-4000-8000-000000000022",
      position,
      color,
    })
    await activeSetup?.renderOnce()
  })

  await act(async () => {
    for (const character of "abc") {
      activeSetup?.mockInput.pressKey(character)
      await activeSetup?.renderOnce()
    }
  })

  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("abc")
  expect(frame).not.toContain("cba")

  await act(async () => {
    activeSetup?.mockInput.pressArrow("left")
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressKey("X")
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("abXc")

  await act(async () => {
    activeSetup?.mockInput.pressArrow("left")
    await activeSetup?.renderOnce()
    await activeSetup?.mockInput.pasteBracketedText("Y")
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("abYXc")

  await act(async () => {
    activeSetup?.mockInput.pressBackspace()
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("abXc")

  await act(async () => {
    activeSetup?.mockInput.pressEnter({ ctrl: true })
    await activeSetup?.renderOnce()
  })
  expect(JSON.parse(fixture.sent.at(-1) ?? "{}")).toMatchObject({
    type: "publish_sticky_note",
    text: "abXc",
  })
})

test("Navigate arrows pan only the private viewport and emit no shared activity", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressTab()
    activeSetup?.mockInput.pressArrow("right")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("left")
    await activeSetup?.renderOnce()
  })

  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Canvas Board · Connected · 1 online · Space actions")
  expect(frame).toContain("origin note")
  expect(fixture.sent).toEqual([])
})

test("Move previews a selected Sticky Note and sends only on commit", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressKey(" ")
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("Read the selected Sticky Note and its edit history.")

  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressArrow("down")
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressArrow("right")
    await activeSetup?.renderOnce()
  })
  expect(fixture.sent).toEqual([])
  const movePreview = activeSetup.captureCharFrame()
  expect(movePreview).toContain("Move Sticky Note")
  expect(movePreview).toContain("origin note")

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  expect(JSON.parse(fixture.sent.at(-1) ?? "{}")).toEqual({
    type: "move_sticky_note",
    stickyNoteId: "Rz8v4oX9nL3qS6tU0wZ5cD",
    direction: "right",
  })
  let frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Saving Position")

  await act(async () => {
    fixture.handlers?.onStickyNoteMoved?.({
      type: "sticky_note_moved",
      revision: 4,
      stickyNote: {
        ...createSnapshot(3).stickyNotes![0]!,
        position: { x: 1, y: 0 },
      },
    })
    await activeSetup?.renderOnce()
  })
  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Position committed")
})

test("reconnect keeps the last canvas snapshot visible without sending mutations", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressTab()
    activeSetup?.mockInput.pressArrow("right")
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("origin note")

  await act(async () => {
    fixture.handlers?.onClose()
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("Reconnecting to the Tuiscrib Service…")
  expect(activeSetup.captureCharFrame()).toContain("origin note")

  await act(async () => {
    fixture.handlers?.onSnapshot(createSnapshot(9))
    await activeSetup?.renderOnce()
  })
  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Canvas Board · Connected · 1 online")
  expect(frame).toContain("origin note")
  expect(fixture.sent).toEqual([])
})

test("keeps below-minimum terminals on the deterministic resize-required screen", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 79, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressArrow("right")
    activeSetup?.mockInput.pressArrow("right", { ctrl: true })
    await activeSetup?.renderOnce()
  })

  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Resize required")
  expect(frame).toContain("needs at least 80 by 24 cells")
  expect(frame).not.toContain("Board canvas")
  expect(fixture.sent).toEqual([])
})

test("renders overlapping Sticky Notes in deterministic front order", async () => {
  const fixture = createOverlappingBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient, "Overlap Board")

  let frame = activeSetup.captureCharFrame()
  expect(frame).toContain("front note")
  expect(frame).toContain("┌────────────────────────┐")
    expect(frame).toContain("Overlap Board · Connected · 1 online · Space actions")

  await act(async () => {
    activeSetup?.mockInput.pressTab()
    await activeSetup?.renderOnce()
  })
  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Overlap Board · Connected · 1 online · Space actions")

  await act(async () => {
    activeSetup?.mockInput.pressTab()
    await activeSetup?.renderOnce()
  })
  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Overlap Board · Connected · 1 online · Space actions")
  expect(fixture.sent).toEqual([])
})

async function renderCanvas(
  dimensions: { width: number; height: number },
  boardClient: BoardClient,
  boardName = "Canvas Board",
  kittyKeyboard = true,
) {
  const credential = "a".repeat(43)
  const authClient: AuthClient = {
    register: async () => { throw new Error("register was not expected") },
    signIn: async () => { throw new Error("sign-in was not expected") },
    restore: async () => ({ user: { username: "ada_lovelace" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://canvas-navigation/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }

  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(
      <TerminalShell
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { ...dimensions, kittyKeyboard },
    )
    await setup.renderOnce()
  })
  if (dimensions.width < 80 || dimensions.height < 24) {
    return setup
  }
  await setup.waitForFrame((frame) =>
    frame.includes("Terminal Session ready") && frame.includes("return to Boards"),
  )
  await act(async () => {
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  await setup.waitForFrame((frame) =>
    frame.includes("Your shared Boards") && frame.includes(boardName),
  )
  await act(async () => {
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  await setup.waitForFrame((frame) => frame.includes(`${boardName} · Connected`))
  return setup
}

function createBoardFixture(): {
  boardClient: BoardClient
  sent: string[]
  handlers?: BoardConnectionHandlers
} {
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Canvas Board",
    role: "member" as const,
  }
  let handlers: BoardConnectionHandlers | undefined
  const sent: string[] = []
  const boardClient: BoardClient = {
    createBoard: async () => { throw new Error("create Board was not expected") },
    joinBoard: async () => { throw new Error("join Board was not expected") },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => ({ status: "deleted" }),
    renameBoard: async () => { throw new Error("rename Board was not expected") },
    rotateJoinCode: async () => { throw new Error("rotate Join Code was not expected") },
    listBoards: async () => ({ boards: [board] }),
    openBoard: async (_credential, _boardId, nextHandlers) => {
      handlers = nextHandlers
      nextHandlers.onSnapshot(createSnapshot(3))
      return {
        send(command) {
          sent.push(JSON.stringify(command))
        },
        close: () => undefined,
      }
    },
  }
  return {
    boardClient,
    sent,
    get handlers() {
      return handlers
    },
  }
}

function createOverlappingBoardFixture(): {
  boardClient: BoardClient
  sent: string[]
  snapshot: BoardSnapshot
  handlers?: BoardConnectionHandlers
} {
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Overlap Board",
    role: "member" as const,
  }
  const timestamp = "2026-08-10T00:00:00.000Z"
  const notes = [
    {
      id: "Rz8v4oX9nL3qS6tU0wZ5cD",
      text: "back note",
      textVersion: 1,
      position: { x: 0, y: 0 },
      color: "yellow" as const,
      stackingOrder: 0,
      authorship: { member: { username: "ada_lovelace" } },
      createdAt: timestamp,
      lastEdit: { member: { username: "ada_lovelace" }, at: timestamp },
    },
    {
      id: "Sz9w5pY0oM4rT7uV1xA6eE",
      text: "middle note",
      textVersion: 1,
      position: { x: 0, y: 0 },
      color: "blue" as const,
      stackingOrder: 1,
      authorship: { member: { username: "ada_lovelace" } },
      createdAt: timestamp,
      lastEdit: { member: { username: "ada_lovelace" }, at: timestamp },
    },
    {
      id: "Ta0x6qZ1pN5sU8vW2yB7fF",
      text: "front note",
      textVersion: 1,
      position: { x: 0, y: 0 },
      color: "green" as const,
      stackingOrder: 2,
      authorship: { member: { username: "ada_lovelace" } },
      createdAt: timestamp,
      lastEdit: { member: { username: "ada_lovelace" }, at: timestamp },
    },
  ]
  const sent: string[] = []
  let fixtureHandlers: BoardConnectionHandlers | undefined
  const snapshot: BoardSnapshot = {
    type: "snapshot",
    board,
    revision: 3,
    presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
    stickyNotes: notes,
  }
  const boardClient: BoardClient = {
    createBoard: async () => { throw new Error("create Board was not expected") },
    joinBoard: async () => { throw new Error("join Board was not expected") },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => ({ status: "deleted" }),
    renameBoard: async () => { throw new Error("rename Board was not expected") },
    rotateJoinCode: async () => { throw new Error("rotate Join Code was not expected") },
    listBoards: async () => ({ boards: [board] }),
    openBoard: async (_credential, _boardId, handlers) => {
      // Keep the public callback seam available to the rendered acceptance test.
      fixtureHandlers = handlers
      handlers.onSnapshot(snapshot)
      return {
        send(command) {
          sent.push(JSON.stringify(command))
        },
        close: () => undefined,
      }
    },
  }
  return {
    boardClient,
    sent,
    snapshot,
    get handlers() {
      return fixtureHandlers
    },
  }
}

function createSnapshot(revision: number): BoardSnapshot {
  const timestamp = "2026-08-10T00:00:00.000Z"
  return {
    type: "snapshot",
    board: {
      id: "Qx7u3nW8kM2pR5sT9vY4aB",
      name: "Canvas Board",
      role: "member",
    },
    revision,
    presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
    stickyNotes: [{
      id: "Rz8v4oX9nL3qS6tU0wZ5cD",
      text: "origin note",
      textVersion: 1,
      position: { x: 0, y: 0 },
      color: "yellow",
      stackingOrder: 0,
      authorship: { member: { username: "ada_lovelace" } },
      createdAt: timestamp,
      lastEdit: { member: { username: "ada_lovelace" }, at: timestamp },
    }],
  }
}
