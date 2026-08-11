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

test("renders private cursor navigation and viewport following at multiple terminal sizes", async () => {
  for (const dimensions of [
    { width: 80, height: 24 },
    { width: 100, height: 30 },
  ]) {
    const fixture = createBoardFixture()
    activeSetup = await renderCanvas(dimensions, fixture.boardClient)

    let frame = activeSetup.captureCharFrame()
    expect(frame).toContain("Canvas cursor: (0, 0)")
    expect(frame).toContain("Viewport origin: (0, 0)")
    expect(frame).toContain("Selected Sticky Note: origin note")
    expect(frame).toContain("Navigate mode · Sticky Note selected")

    await pressKey("right")
    frame = activeSetup.captureCharFrame()
    expect(frame).toContain("Canvas cursor: (1, 0)")
    expect(frame).toContain("Viewport origin: (0, 0)")
    expect(frame).toContain("Navigate mode · Sticky Note selected")

    await pressKey("j")
    frame = activeSetup.captureCharFrame()
    expect(frame).toContain("Canvas cursor: (1, 1)")
    await pressKey("h")
    frame = activeSetup.captureCharFrame()
    expect(frame).toContain("Canvas cursor: (0, 1)")
    await pressKey("k")
    frame = activeSetup.captureCharFrame()
    expect(frame).toContain("Canvas cursor: (0, 0)")

    await act(async () => {
      for (let index = 0; index < 100; index += 1) {
        activeSetup?.mockInput.pressArrow("right")
      }
      await activeSetup?.renderOnce()
    })
    frame = activeSetup.captureCharFrame()
    expect(frame).toContain("Canvas cursor: (100, 0)")
    expect(frame).not.toContain("Viewport origin: (0, 0)")
    expect(frame).toContain("Board revision: 3")
    expect(frame).toContain("ada_lovelace · viewing")
    expect(fixture.sent).toEqual([])
    expect(frame).toContain("Selected Sticky Note: origin note")
    expect(frame).toContain("Navigate mode · Sticky Note selected")

    await act(async () => {
      activeSetup?.renderer.destroy()
    })
    activeSetup = null
  }

  async function pressKey(key: "right" | "j" | "h" | "k"): Promise<void> {
    if (!activeSetup) {
      throw new Error("terminal renderer did not start")
    }
    const setup = activeSetup
    await act(async () => {
      if (key === "right") {
        setup.mockInput.pressArrow("right")
      } else {
        setup.mockInput.pressKey(key)
      }
      await setup.renderOnce()
    })
  }
})

test("Ctrl navigation pans only the private viewport and emits no shared activity", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressArrow("right", { ctrl: true })
    activeSetup?.mockInput.pressKey("j", { ctrl: true })
    activeSetup?.mockInput.pressKey("h", { ctrl: true })
    await activeSetup?.renderOnce()
  })

  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Canvas cursor: (0, 0)")
  expect(frame).toContain("Viewport origin: (0, 1)")
  expect(frame).toContain("Board revision: 3")
  expect(frame).toContain("ada_lovelace · viewing")
  expect(fixture.sent).toEqual([])
})

test("authoritative reconnect snapshots reset private navigation without changing selection or shared state", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 80, height: 24 }, fixture.boardClient)

  await act(async () => {
    for (let index = 0; index < 100; index += 1) {
      activeSetup?.mockInput.pressArrow("right")
    }
    activeSetup?.mockInput.pressArrow("down", { ctrl: true })
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("Viewport origin:")

  await act(async () => {
    fixture.handlers?.onClose()
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("Connection: RECONNECTING")

  await act(async () => {
    fixture.handlers?.onSnapshot(createSnapshot(9))
    await activeSetup?.renderOnce()
  })
  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Connection: CONNECTED")
  expect(frame).toContain("Board revision: 9")
  expect(frame).toContain("Canvas cursor: (0, 0)")
  expect(frame).toContain("Viewport origin: (0, 0)")
  expect(frame).toContain("Selected Sticky Note: origin note")
  expect(frame).toContain("ada_lovelace · viewing")
  expect(fixture.sent).toEqual([])
})

test("keeps below-minimum terminals on the deterministic resize-required screen", async () => {
  const fixture = createBoardFixture()
  activeSetup = await renderCanvas({ width: 79, height: 24 }, fixture.boardClient)

  await act(async () => {
    activeSetup?.mockInput.pressArrow("right")
    activeSetup?.mockInput.pressKey("j")
    activeSetup?.mockInput.pressArrow("right", { ctrl: true })
    await activeSetup?.renderOnce()
  })

  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Resize required")
  expect(frame).toContain("needs at least 80 by 24 cells")
  expect(frame).not.toContain("Board canvas")
  expect(fixture.sent).toEqual([])
})

async function renderCanvas(
  dimensions: { width: number; height: number },
  boardClient: BoardClient,
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
      { ...dimensions, kittyKeyboard: true },
    )
    await setup.renderOnce()
  })
  if (dimensions.width < 80 || dimensions.height < 24) {
    return setup
  }
  await setup.waitForFrame((frame) => frame.includes("Terminal Session restored"))
  await act(async () => {
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
  })
  await setup.waitForFrame((frame) => frame.includes("Canvas Board"))
  await act(async () => {
    setup.mockInput.pressKey("o")
    await setup.renderOnce()
  })
  await setup.waitForFrame((frame) => frame.includes("Board revision: 3"))
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
