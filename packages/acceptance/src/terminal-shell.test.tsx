import { afterEach, expect, test } from "bun:test"
import { createTerminalCapabilities, type TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { BoardSnapshot, StickyNote } from "@tuiscrib/contracts"

import {
  TerminalShell,
  ServiceRequestError,
  type AuthClient,
  type BoardClient,
  type CredentialStore,
} from "@tuiscrib/terminal"

let activeSetup: TestRendererSetup | null = null

afterEach(async () => {
  await act(async () => {
    activeSetup?.renderer.destroy()
  })
  activeSetup = null
})

test("opens keyboard help from the Navigate shell and returns with Escape", async () => {
  activeSetup = await testRender(<TerminalShell label="alpha" />, {
    width: 80,
    height: 24,
    kittyKeyboard: true,
  })

  await activeSetup.renderOnce()
  const initialFrame = activeSetup.captureCharFrame()

  expect(activeSetup.captureSpans().lines[0]?.spans[0]?.bg.toInts()).toEqual([0, 0, 0, 255])
  expect(initialFrame).toContain("Welcome to Tuiscrib")
  expect(initialFrame).toContain("TUISCRIB")
  expect(initialFrame).toContain("NAVIGATE")
  expect(initialFrame).toContain("boards")
  expect(initialFrame).toContain("↑↓ choose · Enter select")

  await act(async () => {
    activeSetup?.mockInput.pressKey("?")
    await activeSetup?.renderOnce()
  })

  const helpFrame = activeSetup.captureCharFrame()
  expect(helpFrame).toContain("Keyboard help")
  expect(helpFrame).toContain("Escape close")
  expect(helpFrame).toContain("Arrows navigate")
  expect(helpFrame).toContain("Ctrl+Enter save")

  await act(async () => {
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
    await activeSetup?.flush()
  })

  const returnedFrame = await activeSetup.waitForFrame((frame) => !frame.includes("Keyboard help"))
  expect(returnedFrame).toContain("NAVIGATE")
  expect(returnedFrame).not.toContain("Keyboard help")
})

test("navigates the shell menu with keyboard hints and opens Boards", async () => {
  activeSetup = await testRender(<TerminalShell label="alpha" />, {
    width: 80,
    height: 24,
    kittyKeyboard: true,
  })

  await activeSetup.renderOnce()
  expectFixedShellPanel(activeSetup.captureCharFrame())
  expectNavigationPinnedToPanelBottom(
    activeSetup.captureCharFrame(),
    "↑↓ choose · Enter select",
  )
  const titleLine = activeSetup.captureCharFrame().split("\n").find((line) => line.includes("TUISCRIB"))
  expect(titleLine?.indexOf("TUISCRIB")).toBe(36)

  await act(async () => {
    activeSetup?.mockInput.pressArrow("up")
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("› sign out")

  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("› boards")

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  expect(activeSetup.captureCharFrame()).toContain("Boards")
  expectFixedShellPanel(activeSetup.captureCharFrame())
  expectNavigationPinnedToPanelBottom(
    activeSetup.captureCharFrame(),
    "↑↓ choose · Enter select · Esc back",
  )
  expect(activeSetup.captureCharFrame()).toContain("open Board")
  expect(activeSetup.captureCharFrame()).toContain("Open the collaboration canvas")
  expect(activeSetup.captureCharFrame()).toContain("create Board")
  expect(activeSetup.captureCharFrame()).toContain("join Board")
  expect(activeSetup.captureCharFrame()).not.toContain("hjkl")

  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  expect(activeSetup.captureCharFrame()).toContain("Create Board")
  expectFixedShellPanel(activeSetup.captureCharFrame())
})

function expectFixedShellPanel(frame: string): void {
  const topBorder = frame.split("\n").find((line) => line.includes("┌"))
  expect(topBorder).toContain(`┌${"─".repeat(70)}┐`)
}

function expectNavigationPinnedToPanelBottom(frame: string, navigation: string): void {
  const lines = frame.split("\n")
  const navigationLine = lines.findIndex((line) => line.includes(navigation))
  const bottomBorder = lines.findIndex((line) => line.includes(`└${"─".repeat(70)}┘`))
  expect(navigationLine).toBeGreaterThan(-1)
  expect(bottomBorder).toBeGreaterThan(-1)
  expect(bottomBorder - navigationLine).toBe(3)
}

test("redeems a Join Code from the keyboard form and renders the new Membership", async () => {
  const credential = "a".repeat(43)
  let joinedInput: { credential: string; joinCode: string } | undefined
  const joinedBoard = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Ideas",
    role: "member" as const,
  }
  const boardClient: BoardClient = {
    createBoard: async () => {
      throw new Error("create Board was not expected")
    },
    renameBoard: async () => {
      throw new Error("rename Board was not expected")
    },
    rotateJoinCode: async () => {
      throw new Error("rotate Join Code was not expected")
    },
    listBoards: async () => ({ boards: joinedInput ? [joinedBoard] : [] }),
    joinBoard: async (nextCredential, input) => {
      joinedInput = { credential: nextCredential, joinCode: input.joinCode }
      return {
        board: {
          ...joinedBoard,
        },
      }
    },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => ({ status: "deleted" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://join-form/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }
  const authClient: AuthClient = {
    register: async () => {
      throw new Error("register was not expected")
    },
    signIn: async () => {
      throw new Error("sign-in was not expected")
    },
    restore: async () => ({ user: { username: "join_slice_member" } }),
    signOut: async () => ({ status: "signed_out" }),
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        label="member"
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })
  const waitForFrame = async (predicate: (frame: string) => boolean): Promise<string> => {
    let matchedFrame: string | undefined
    let lastFrame = ""
    await act(async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await Bun.sleep(5)
        await activeSetup?.renderOnce()
        lastFrame = activeSetup?.captureCharFrame() ?? ""
        if (predicate(lastFrame)) {
          matchedFrame = lastFrame
          return
        }
      }
    })
    if (matchedFrame !== undefined) {
      return matchedFrame
    }
    throw new Error(`Timed out waiting for rendered frame\n${lastFrame}`)
  }
  await waitForFrame((value) => value.includes("Boards"))

  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((value) => value.includes("Join Board"))
  await act(async () => {
    await activeSetup?.mockInput.typeText("ABCD-EFGH-JKMN-PRST-TVWX-YZ23-45")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  expect(joinedInput).toEqual({
    credential,
    joinCode: "ABCD-EFGH-JKMN-PRST-TVWX-YZ23-45",
  })
  const frame = await waitForFrame((value) => value.includes("Ideas"))
  expect(frame).toContain("Board \"Ideas\" joined.")
  expect(frame).toContain("Ideas · Member")
})

test("confirms leaving a Board from Board actions and removes the Membership", async () => {
  const credential = "b".repeat(43)
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Ideas",
    role: "member" as const,
  }
  let left = false
  let leaveInput: { credential: string; boardId: string } | undefined
  const boardClient: BoardClient = {
    createBoard: async () => {
      throw new Error("create Board was not expected")
    },
    renameBoard: async () => {
      throw new Error("rename Board was not expected")
    },
    rotateJoinCode: async () => {
      throw new Error("rotate Join Code was not expected")
    },
    listBoards: async () => ({ boards: left ? [] : [board] }),
    joinBoard: async () => {
      throw new Error("join Board was not expected")
    },
    leaveBoard: async (nextCredential, boardId) => {
      leaveInput = { credential: nextCredential, boardId }
      left = true
      return { status: "left" }
    },
    deleteBoard: async () => ({ status: "deleted" }),
  }
  const authClient: AuthClient = {
    register: async () => {
      throw new Error("register was not expected")
    },
    signIn: async () => {
      throw new Error("sign-in was not expected")
    },
    restore: async () => ({ user: { username: "leave_slice_member" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://leave-form/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        label="member"
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })
  const waitForFrame = async (predicate: (frame: string) => boolean): Promise<string> => {
    let matchedFrame: string | undefined
    let lastFrame = ""
    await act(async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await Bun.sleep(5)
        await activeSetup?.renderOnce()
        lastFrame = activeSetup?.captureCharFrame() ?? ""
        if (predicate(lastFrame)) {
          matchedFrame = lastFrame
          return
        }
      }
    })
    if (matchedFrame !== undefined) {
      return matchedFrame
    }
    throw new Error(`Timed out waiting for rendered frame\n${lastFrame}`)
  }

  await waitForFrame((value) => value.includes("Boards"))
  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((value) => value.includes("Board actions"))
  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((value) => value.includes("Confirm leaving Board"))
  await act(async () => {
    await Bun.sleep(10)
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressArrow("right")
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  const frame = await waitForFrame((value) => value.includes("Left Board"))
  expect(leaveInput).toEqual({ credential, boardId: board.id })
  expect(frame).toContain("Left Board \"Ideas\".")
  expect(frame).not.toContain("Ideas · Member")
})

test("clearly prevents the Owner from leaving a Board in Board actions", async () => {
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Ideas",
    role: "owner" as const,
  }
  let leaveCalled = false
  const boardClient: BoardClient = {
    createBoard: async () => {
      throw new Error("create Board was not expected")
    },
    renameBoard: async () => {
      throw new Error("rename Board was not expected")
    },
    rotateJoinCode: async () => {
      throw new Error("rotate Join Code was not expected")
    },
    listBoards: async () => ({ boards: [board] }),
    joinBoard: async () => {
      throw new Error("join Board was not expected")
    },
    leaveBoard: async () => {
      leaveCalled = true
      return { status: "left" }
    },
    deleteBoard: async () => ({ status: "deleted" }),
  }
  const authClient: AuthClient = {
    register: async () => {
      throw new Error("register was not expected")
    },
    signIn: async () => {
      throw new Error("sign-in was not expected")
    },
    restore: async () => ({ user: { username: "owner_slice_user" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://owner-form/session",
    load: async () => "c".repeat(43),
    save: async () => undefined,
    remove: async () => undefined,
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        label="owner"
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })
  const waitForFrame = async (predicate: (frame: string) => boolean): Promise<string> => {
    let matchedFrame: string | undefined
    let lastFrame = ""
    await act(async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await Bun.sleep(5)
        await activeSetup?.renderOnce()
        lastFrame = activeSetup?.captureCharFrame() ?? ""
        if (predicate(lastFrame)) {
          matchedFrame = lastFrame
          return
        }
      }
    })
    if (matchedFrame !== undefined) {
      return matchedFrame
    }
    throw new Error(`Timed out waiting for rendered frame\n${lastFrame}`)
  }

  await waitForFrame((value) => value.includes("Boards"))
  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((value) => value.includes("Board actions"))
  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  const frame = await waitForFrame((value) => value.includes("The Owner cannot leave this Board."))
  expect(frame).toContain("Error: The Owner cannot leave this Board.")
  expect(leaveCalled).toBe(false)
})

test("renames a Board and rotates its Join Code from the rendered Owner actions", async () => {
  const credential = "d".repeat(43)
  const originalBoard = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Ideas",
    role: "owner" as const,
  }
  const renamedBoard = { ...originalBoard, name: "Renamed Ideas" }
  const rotatedJoinCode = "WXYZ-2345-6789-ABCD-EFGH-JKMN-PQ"
  let boards = [originalBoard]
  let renameInput: { credential: string; boardId: string; name: string } | undefined
  let rotateInput: { credential: string; boardId: string } | undefined
  let copiedJoinCode: string | undefined

  const boardClient: BoardClient = {
    createBoard: async () => {
      throw new Error("create Board was not expected")
    },
    listBoards: async () => ({ boards }),
    joinBoard: async () => {
      throw new Error("join Board was not expected")
    },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => ({ status: "deleted" }),
    renameBoard: async (nextCredential, boardId, input) => {
      renameInput = { credential: nextCredential, boardId, name: input.name }
      boards = [renamedBoard]
      return { board: renamedBoard }
    },
    rotateJoinCode: async (nextCredential, boardId) => {
      rotateInput = { credential: nextCredential, boardId }
      return { board: renamedBoard, joinCode: rotatedJoinCode }
    },
  }
  const authClient: AuthClient = {
    register: async () => {
      throw new Error("register was not expected")
    },
    signIn: async () => {
      throw new Error("sign-in was not expected")
    },
    restore: async () => ({ user: { username: "owner_slice_user" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://governance-form/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        label="owner"
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })
  if (activeSetup) {
    activeSetup.renderer.copyToClipboardOSC52 = (text: string) => {
      copiedJoinCode = text
      return true
    }
  }

  const waitForFrame = async (predicate: (frame: string) => boolean): Promise<string> => {
    let matchedFrame: string | undefined
    let lastFrame = ""
    await act(async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await Bun.sleep(5)
        await activeSetup?.renderOnce()
        lastFrame = activeSetup?.captureCharFrame() ?? ""
        if (predicate(lastFrame)) {
          matchedFrame = lastFrame
          return
        }
      }
    })
    if (matchedFrame !== undefined) {
      return matchedFrame
    }
    throw new Error(`Timed out waiting for rendered frame\n${lastFrame}`)
  }

  await waitForFrame((value) => value.includes("Boards"))
  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((value) => value.includes("Ideas · Owner"))
  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((value) => value.includes("Rename Board"))
  await act(async () => {
    await activeSetup?.mockInput.typeText("Renamed Ideas")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  await waitForFrame((value) => value.includes("Renamed Ideas · Owner"))
  expect(renameInput).toEqual({
    credential,
    boardId: originalBoard.id,
    name: "Renamed Ideas",
  })

  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  const frame = await waitForFrame((value) => value.includes("Rotated Join Code"))
  expect(frame).toContain(rotatedJoinCode)
  expect(frame).not.toContain("Initial Join Code")
  expect(frame).toContain("[ c ] Copy")
  expect(rotateInput).toEqual({ credential, boardId: originalBoard.id })

  const copyLine = frame.split("\n").findIndex((line) => line.includes("[ c ] Copy"))
  const copyColumn = frame.split("\n")[copyLine]?.indexOf("[ c ] Copy") ?? -1
  expect(copyLine).toBeGreaterThan(-1)
  expect(copyColumn).toBeGreaterThan(-1)
  await act(async () => {
    await activeSetup?.mockMouse.click(copyColumn + 1, copyLine)
    await activeSetup?.renderOnce()
  })
  expect(copiedJoinCode).toBe(rotatedJoinCode)
  expect(activeSetup?.captureCharFrame()).toContain("Join Code copied to the clipboard.")

  if (activeSetup) {
    activeSetup.renderer.copyToClipboardOSC52 = () => false
  }
  await act(async () => {
    activeSetup?.mockInput.pressKey("c")
    await activeSetup?.renderOnce()
  })
  expect(activeSetup?.captureCharFrame()).toContain("Clipboard access is unavailable.")
  expect(activeSetup?.captureCharFrame()).toContain("Code manually.")

  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((value) => value.includes("Board actions"))
  await act(async () => {
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
  })
  const clearedFrame = await waitForFrame(
    (value) => value.includes("Boards") && !value.includes(rotatedJoinCode),
  )
  expect(clearedFrame).not.toContain(rotatedJoinCode)
})

test("renders Owner-only authorization errors for Member Board actions", async () => {
  const credential = "e".repeat(43)
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Ideas",
    role: "member" as const,
  }
  const boardClient: BoardClient = {
    createBoard: async () => {
      throw new Error("create Board was not expected")
    },
    listBoards: async () => ({ boards: [board] }),
    joinBoard: async () => {
      throw new Error("join Board was not expected")
    },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => {
      throw new Error("delete Board was not expected")
    },
    renameBoard: async () => {
      throw new ServiceRequestError(403, {
        error: "Only the Owner may rename this Board.",
        code: "owner_required",
      })
    },
    rotateJoinCode: async () => {
      throw new ServiceRequestError(403, {
        error: "Only the Owner may rotate this Join Code.",
        code: "owner_required",
      })
    },
  }
  const authClient: AuthClient = {
    register: async () => {
      throw new Error("register was not expected")
    },
    signIn: async () => {
      throw new Error("sign-in was not expected")
    },
    restore: async () => ({ user: { username: "member_slice_user" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://member-governance/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        label="member"
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })

  const waitForFrame = async (predicate: (frame: string) => boolean): Promise<string> => {
    let matchedFrame: string | undefined
    let lastFrame = ""
    await act(async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await Bun.sleep(5)
        await activeSetup?.renderOnce()
        lastFrame = activeSetup?.captureCharFrame() ?? ""
        if (predicate(lastFrame)) {
          matchedFrame = lastFrame
          return
        }
      }
    })
    if (matchedFrame !== undefined) {
      return matchedFrame
    }
    throw new Error(`Timed out waiting for rendered frame\n${lastFrame}`)
  }

  await waitForFrame((value) => value.includes("Boards"))
  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((value) => value.includes("Board actions"))
  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((value) => value.includes("Rename Board"))
  await act(async () => {
    await activeSetup?.mockInput.typeText("Nope")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  const renameFrame = await waitForFrame((value) => value.includes("Only the Owner may rename"))
  expect(renameFrame).toContain("Error: Only the Owner may rename this Board.")

  await act(async () => {
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  const rotateFrame = await waitForFrame((value) => value.includes("Only the Owner may rotate"))
  expect(rotateFrame).toContain("Error: Only the Owner may rotate this Join Code.")

  await act(async () => {
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  const deleteFrame = await waitForFrame((value) => value.includes("Only the Owner may delete"))
  expect(deleteFrame).toContain("Error: Only the Owner may delete this Board.")
})

test("uses the reusable Register form with visible validation and status", async () => {
  activeSetup = await testRender(<TerminalShell label="alpha" />, {
    width: 80,
    height: 24,
    kittyKeyboard: true,
  })

  await activeSetup.renderOnce()

  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  let frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Register User")
  expect(frame).toContain("Username")
  expect(frame).toContain("Password")
  expect(frame).toContain("Confirm password")
  expect(frame).toContain("↑↓ fields · Enter submit · Escape cancel")

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Error: Username is required.")

  await act(async () => {
    await activeSetup?.mockInput.typeText("alice")
    activeSetup?.mockInput.pressTab()
    await activeSetup?.renderOnce()
    await activeSetup?.mockInput.typeText("pass phrase")
    activeSetup?.mockInput.pressTab()
    await activeSetup?.renderOnce()
    await activeSetup?.mockInput.typeText("pass phrase")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("registration form complete")
  expect(frame).toContain("NAVIGATE")
})

test("requires the exact current Board name and lets Escape cancel without deleting", async () => {
  const credential = "a".repeat(43)
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Ideas",
    role: "owner" as const,
  }
  let deleted = false
  let deleteCalls = 0
  const boardClient: BoardClient = {
    createBoard: async () => { throw new Error("create Board was not expected") },
    joinBoard: async () => { throw new Error("join Board was not expected") },
    leaveBoard: async () => ({ status: "left" }),
    renameBoard: async () => { throw new Error("rename Board was not expected") },
    rotateJoinCode: async () => { throw new Error("rotate Join Code was not expected") },
    deleteBoard: async () => {
      deleteCalls += 1
      deleted = true
      return { status: "deleted" }
    },
    listBoards: async () => ({ boards: deleted ? [] : [board] }),
  }
  const authClient: AuthClient = {
    register: async () => { throw new Error("register was not expected") },
    signIn: async () => { throw new Error("sign-in was not expected") },
    restore: async () => ({ user: { username: "ada_lovelace" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://board-delete/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        label="owner"
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })

  const setup = activeSetup
  if (!setup) {
    throw new Error("terminal renderer did not start")
  }
  await setup.waitForFrame((frame) => frame.includes("Boards"))
  await act(async () => {
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  await setup.waitForFrame((frame) => frame.includes("Ideas · Owner"))
  await act(async () => {
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })

  let frame = setup.captureCharFrame()
  expect(frame).toContain("Permanently delete Board")
  expect(frame).toContain("Type Board name exactly")
  expect(frame).toContain("Every connected Member will lose access immediately.")

  await act(async () => {
    setup.mockInput.typeText("Wrong")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  frame = setup.captureCharFrame()
  expect(frame).toContain("Type the exact current Board name")
  expect(deleteCalls).toBe(0)

  await act(async () => {
    setup.mockInput.pressEscape()
    await setup.renderOnce()
  })
  expect(setup.captureCharFrame()).toContain("Board actions")
  expect(deleteCalls).toBe(0)

  await act(async () => {
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.typeText("Ideas")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  frame = await setup.waitForFrame((value) => value.includes("Board \"Ideas\" deleted permanently."))
  expect(frame).toContain("Boards")
  expect(deleteCalls).toBe(1)
  expect(deleted).toBe(true)
})

test("keeps Navigate and Select mode presentation visibly distinct", async () => {
  activeSetup = await testRender(<TerminalShell label="alpha" />, {
    width: 80,
    height: 24,
    kittyKeyboard: true,
  })

  await activeSetup.renderOnce()

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  let frame = activeSetup.captureCharFrame()
  expect(frame).toContain("NAVIGATE")
  expect(frame).toContain("No Sticky Notes yet")
  expect(frame).toContain("Enter to add one")

  await act(async () => {
    activeSetup?.mockInput.pressTab()
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("SELECT")
  expect(frame).toContain("Space actions")

  await act(async () => {
    activeSetup?.mockInput.pressTab()
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("NAVIGATE")

  await act(async () => {
    activeSetup?.mockInput.pressKey("?")
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Keyboard help")

  await act(async () => {
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
  })

  expect(activeSetup.captureCharFrame()).toContain("NAVIGATE")
})

test("shows a resize-required screen below the supported minimum", async () => {
  activeSetup = await testRender(<TerminalShell label="alpha" />, {
    width: 79,
    height: 24,
    kittyKeyboard: true,
  })

  await activeSetup.renderOnce()
  let frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Resize required")
  expect(frame).toContain("needs at least 80 by 24 cells")
  expect(frame).toContain("Current terminal: 79 by 24")
  expect(frame).not.toContain("NAVIGATE")

  await act(async () => {
    activeSetup?.resize(80, 24)
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("NAVIGATE")
})

test("reports truecolor only when the terminal capability is detected", async () => {
  activeSetup = await testRender(
    <TerminalShell
      label="alpha"
      capabilities={createTerminalCapabilities({ rgb: true, ansi256: true })}
    />,
    {
      width: 80,
      height: 24,
      kittyKeyboard: true,
    },
  )

  await activeSetup.renderOnce()
  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Welcome to Tuiscrib")
  expect(frame).not.toContain("truecolor detected")
})

test("keeps the baseline capability label when truecolor is unavailable", async () => {
  activeSetup = await testRender(
    <TerminalShell
      label="alpha"
      capabilities={createTerminalCapabilities({ rgb: false, ansi256: true })}
    />,
    {
      width: 80,
      height: 24,
      kittyKeyboard: true,
    },
  )

  await activeSetup.renderOnce()
  const frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Welcome to Tuiscrib")
  expect(frame).not.toContain("truecolor detected")
})

test("restores a persisted Terminal Session and signs out through keyboard controls", async () => {
  const credential = "a".repeat(43)
  let removed = false
  let restoredCredential = ""
  let signedOutCredential = ""
  const credentialStore: CredentialStore = {
    filePath: "/protected/tuiscrib/session",
    load: async () => (removed ? null : credential),
    save: async () => undefined,
    remove: async () => {
      removed = true
    },
  }
  const authClient: AuthClient = {
    register: async () => {
      throw new Error("not used")
    },
    signIn: async () => {
      throw new Error("not used")
    },
    restore: async (value) => {
      restoredCredential = value
      return { user: { username: "ada_lovelace" } }
    },
    signOut: async (value) => {
      signedOutCredential = value
      return { status: "signed_out" }
    },
  }

  activeSetup = await testRender(
    <TerminalShell
      label="auth-client"
      authClient={authClient}
      credentialStore={credentialStore}
    />,
    {
      width: 80,
      height: 24,
      kittyKeyboard: true,
    },
  )

  await act(async () => {
    await activeSetup?.waitForFrame((frame) => frame.includes("Boards"))
  })
  expect(restoredCredential).toBe(credential)
  expect(activeSetup.captureCharFrame()).toContain("ada_lovelace")
  expect(activeSetup.captureCharFrame()).not.toContain(credential)

  await act(async () => {
    activeSetup?.mockInput.pressEscape()
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  let frame = ""
  await act(async () => {
    frame = await activeSetup?.waitForFrame((value) => value.includes("Signed out")) ?? ""
  })
  expect(frame).toContain("Terminal Session revoked")
  expect(signedOutCredential).toBe(credential)
  expect(removed).toBe(true)
  expect(frame).not.toContain(credential)
})

test("returns to sign-in with a clear error when no local Terminal Session exists", async () => {
  let restoreCalled = false
  const credentialStore: CredentialStore = {
    filePath: "/protected/tuiscrib/session",
    load: async () => null,
    save: async () => undefined,
    remove: async () => undefined,
  }
  const authClient: AuthClient = {
    register: async () => {
      throw new Error("not used")
    },
    signIn: async () => {
      throw new Error("not used")
    },
    restore: async () => {
      restoreCalled = true
      return { user: { username: "unused" } }
    },
    signOut: async () => ({ status: "signed_out" }),
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell authClient={authClient} credentialStore={credentialStore} />,
      {
        width: 80,
        height: 24,
        kittyKeyboard: true,
      },
    )
    await activeSetup.renderOnce()
  })

  let frame = ""
  await act(async () => {
    frame = await activeSetup?.waitForFrame((value) => value.includes("No saved Terminal Session")) ?? ""
  })
  expect(frame).toContain("Error: No saved Terminal Session.")
  expect(frame).toContain("continue.")
  expect(frame).toContain("sign in")
  expect(restoreCalled).toBe(false)
})

test("opens the selected Board through its WebSocket and renders authoritative viewing Presence", async () => {
  const credential = "d".repeat(43)
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Ideas",
    role: "member" as const,
  }
  let opened: { credential: string; boardId: string } | undefined
  const boardClient: BoardClient = {
    createBoard: async () => {
      throw new Error("create Board was not expected")
    },
    renameBoard: async () => {
      throw new Error("rename Board was not expected")
    },
    rotateJoinCode: async () => {
      throw new Error("rotate Join Code was not expected")
    },
    listBoards: async () => ({ boards: [board] }),
    joinBoard: async () => {
      throw new Error("join Board was not expected")
    },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => ({ status: "deleted" }),
    openBoard: async (nextCredential, boardId, handlers) => {
      opened = { credential: nextCredential, boardId }
      handlers.onSnapshot({
        type: "snapshot",
        board,
        revision: 3,
        presence: [
          { member: { username: "ada_lovelace" }, activity: "viewing" },
          { member: { username: "grace_hopper" }, activity: "viewing" },
        ],
      })
      return { send: () => undefined, close: () => undefined }
    },
  }
  const authClient: AuthClient = {
    register: async () => {
      throw new Error("register was not expected")
    },
    signIn: async () => {
      throw new Error("sign-in was not expected")
    },
    restore: async () => ({ user: { username: "ada_lovelace" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://board-open/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        label="member"
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })

  const setup = activeSetup
  if (!setup) {
    throw new Error("terminal renderer did not start")
  }
  await setup.waitForFrame((frame) => frame.includes("Boards"))
  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  const frame = await setup.waitForFrame((value) => value.includes("Ideas · Connected"))
  expect(opened).toEqual({ credential, boardId: board.id })
  expect(frame).toContain("Ideas · Connected · 2 online")
  expect(frame).not.toContain("Board canvas")
  expect(frame).not.toContain("ada_lovelace · viewing")
})

test("replaces an optimistic Sticky Note edit with the authoritative conflict response", async () => {
  const credential = "f".repeat(43)
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Conflict Ideas",
    role: "member" as const,
  }
  const originalNote: StickyNote = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    text: "durable text",
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
  }
  const authoritativeNote: StickyNote = {
    ...originalNote,
    text: "authoritative durable text",
    textVersion: 2,
    lastEdit: {
      member: { username: "grace_hopper" },
      at: "2026-08-10T00:01:00.000Z",
    },
  }
  const snapshot: BoardSnapshot = {
    type: "snapshot",
    board,
    revision: 1,
    presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
    stickyNotes: [originalNote],
  }
  let handlers: import("@tuiscrib/terminal").BoardConnectionHandlers | undefined
  const sent: string[] = []
  const boardClient: BoardClient = {
    createBoard: async () => { throw new Error("not used") },
    renameBoard: async () => { throw new Error("not used") },
    rotateJoinCode: async () => { throw new Error("not used") },
    listBoards: async () => ({ boards: [board] }),
    joinBoard: async () => { throw new Error("not used") },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => ({ status: "deleted" }),
    openBoard: async (_nextCredential, _boardId, nextHandlers) => {
      handlers = nextHandlers
      nextHandlers.onSnapshot(snapshot)
      return {
        send(command) {
          sent.push(JSON.stringify(command))
          if (command.type === "begin_sticky_note_edit") {
            nextHandlers.onStickyNoteEditClaimGranted?.({
              type: "sticky_note_edit_claim_granted",
              stickyNoteId: originalNote.id,
              claimId: "00000000-0000-4000-8000-000000000017",
              stickyNote: originalNote,
            })
          }
        },
        close: () => undefined,
      }
    },
  }
  const authClient: AuthClient = {
    register: async () => { throw new Error("not used") },
    signIn: async () => { throw new Error("not used") },
    restore: async () => ({ user: { username: "ada_lovelace" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://sticky-conflict/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        label="conflict-client"
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })

  const setup = activeSetup
  if (!setup) {
    throw new Error("terminal renderer did not start")
  }
  const waitForFrame = async (predicate: (frame: string) => boolean): Promise<string> => {
    let lastFrame = ""
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await Bun.sleep(5)
      await setup.renderOnce()
      lastFrame = setup.captureCharFrame()
      if (predicate(lastFrame)) {
        return lastFrame
      }
    }
    throw new Error(`Timed out waiting for rendered frame\n${lastFrame}`)
  }

  await waitForFrame((frame) => frame.includes("Boards"))
  await act(async () => {
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  await waitForFrame((frame) => frame.includes("durable text") && frame.includes("Conflict Ideas · Connected"))

  await act(async () => {
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  await waitForFrame((frame) => frame.includes("Edit Claim granted"))
  await act(async () => {
    await setup.mockInput.typeText(" stale optimistic text")
    await setup.renderOnce()
  })
  expect(setup.captureCharFrame()).toContain("stale optimistic text")
  expect(sent.some((command) => command.includes("publish_sticky_note_edit"))).toBe(false)

  await act(async () => {
    setup.mockInput.pressEnter({ ctrl: true })
    await setup.renderOnce()
    handlers?.onCommandError?.({
      type: "error",
      code: "text_version_conflict",
      error: "Sticky Note text changed before this publication. Your local text was replaced with the authoritative text.",
      authoritative: { revision: 2, stickyNote: authoritativeNote },
    })
    await setup.renderOnce()
  })

  const conflict = await waitForFrame((frame) => frame.includes("authoritative durable text"))
  expect(conflict).not.toContain("stale optimistic text")
  expect(sent.some((command) => command.includes("begin_sticky_note_edit"))).toBe(true)
})

test("uses a clear destructive confirmation mode for Sticky Note deletion and keeps cancellation selectable", async () => {
  const credential = "g".repeat(43)
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Deletion Ideas",
    role: "member" as const,
  }
  const note: StickyNote = {
    id: "Lm7u3nW8kM2pR5sT9vY4aB",
    text: "delete me",
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
  }
  const snapshot: BoardSnapshot = {
    type: "snapshot",
    board,
    revision: 1,
    presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
    stickyNotes: [note],
  }
  const sent: string[] = []
  let handlers: import("@tuiscrib/terminal").BoardConnectionHandlers | undefined
  let claimNumber = 0
  const boardClient: BoardClient = {
    createBoard: async () => { throw new Error("not used") },
    renameBoard: async () => { throw new Error("not used") },
    rotateJoinCode: async () => { throw new Error("not used") },
    listBoards: async () => ({ boards: [board] }),
    joinBoard: async () => { throw new Error("not used") },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => ({ status: "deleted" }),
    openBoard: async (_nextCredential, _boardId, nextHandlers) => {
      handlers = nextHandlers
      nextHandlers.onSnapshot(snapshot)
      return {
        send(command) {
          sent.push(JSON.stringify(command))
          if (command.type === "delete_sticky_note") {
            nextHandlers.onStickyNoteDeleted?.({
              type: "sticky_note_deleted",
              revision: 2,
              stickyNoteId: note.id,
            })
          }
        },
        close: () => undefined,
      }
    },
  }
  const authClient: AuthClient = {
    register: async () => { throw new Error("not used") },
    signIn: async () => { throw new Error("not used") },
    restore: async () => ({ user: { username: "ada_lovelace" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://sticky-delete/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        label="delete-client"
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })
  const setup = activeSetup
  if (!setup) {
    throw new Error("terminal renderer did not start")
  }
  await setup.waitForFrame((frame) => frame.includes("Boards"))
  await act(async () => {
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  await setup.waitForFrame((frame) => frame.includes("Deletion Ideas · Connected") && frame.includes("delete me"))

  await act(async () => {
    setup.mockInput.pressKey(" ")
    await setup.renderOnce()
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('"type":"begin_sticky_note_edit"')
  expect(setup.captureCharFrame()).not.toContain("Permanently delete")

  await act(async () => {
    claimNumber += 1
    handlers?.onStickyNoteEditClaimGranted?.({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      claimId: `00000000-0000-4000-8000-00000000001${claimNumber}`,
      stickyNote: note,
    })
    await setup.renderOnce()
  })
  const confirmation = setup.captureCharFrame()
  expect(confirmation).toContain("Permanently delete Sticky Note")
  expect(confirmation).toContain("delete me")
  expect(confirmation).toContain("Edit Claim is held")
  expect(confirmation).toContain("› Cancel")

  await act(async () => {
    setup.mockInput.pressEscape()
    await setup.renderOnce()
  })
  expect(setup.captureCharFrame()).toContain("delete me")
  expect(sent.some((command) => command.includes('"type":"delete_sticky_note"'))).toBe(false)

  await act(async () => {
    setup.mockInput.pressKey(" ")
    await setup.renderOnce()
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  expect(sent.some((command) => command.includes('"type":"release_sticky_note_edit"'))).toBe(true)
  expect(setup.captureCharFrame()).toContain("delete me")

  await act(async () => {
    setup.mockInput.pressKey(" ")
    await setup.renderOnce()
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    handlers?.onStickyNoteEditClaimGranted?.({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: note.id,
      claimId: "00000000-0000-4000-8000-000000000019",
      stickyNote: note,
    })
    await setup.renderOnce()
    setup.mockInput.pressArrow("right")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("› Delete permanently")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  const deleted = setup.captureCharFrame()
  expect(sent.some((command) => command.includes('"type":"delete_sticky_note"'))).toBe(true)
  expect(deleted).toContain("No Sticky Notes yet")
  expect(deleted).not.toContain("delete me")
})

test("renders reconnecting after Board loss and does not send shared mutations while disconnected", async () => {
  const credential = "e".repeat(43)
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Reconnect Ideas",
    role: "member" as const,
  }
  const sent: string[] = []
  let handlers: import("@tuiscrib/terminal").BoardConnectionHandlers | undefined
  const boardClient: BoardClient = {
    createBoard: async () => { throw new Error("not used") },
    renameBoard: async () => { throw new Error("not used") },
    rotateJoinCode: async () => { throw new Error("not used") },
    listBoards: async () => ({ boards: [board] }),
    joinBoard: async () => { throw new Error("not used") },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => ({ status: "deleted" }),
    openBoard: async (_nextCredential, _boardId, nextHandlers) => {
      handlers = nextHandlers
      nextHandlers.onSnapshot({
        type: "snapshot",
        board,
        revision: 8,
        presence: [{ member: { username: "ada_lovelace" }, activity: "viewing" }],
        stickyNotes: [],
      })
      return {
        send(command) {
          sent.push(JSON.stringify(command))
        },
        close: () => undefined,
      }
    },
  }
  const authClient: AuthClient = {
    register: async () => { throw new Error("not used") },
    signIn: async () => { throw new Error("not used") },
    restore: async () => ({ user: { username: "ada_lovelace" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
  const credentialStore: CredentialStore = {
    filePath: "memory://reconnect/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        authClient={authClient}
        boardClient={boardClient}
        credentialStore={credentialStore}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })

  const setup = activeSetup
  if (!setup) {
    throw new Error("terminal renderer did not start")
  }
  await setup.waitForFrame((frame) => frame.includes("Boards"))
  await act(async () => {
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  await setup.waitForFrame((frame) => frame.includes("Reconnect Ideas · Connected"))

  await act(async () => {
    handlers?.onClose()
    await setup.renderOnce()
  })
  const reconnecting = setup.captureCharFrame()
  expect(reconnecting).toContain("Reconnecting…")
  expect(reconnecting).toContain("Reconnect Ideas")

  await act(async () => {
    setup.mockInput.pressEnter()
    await setup.renderOnce()
  })
  expect(sent).toEqual([])
  expect(setup.captureCharFrame()).toContain("Reconnecting…")

  await act(async () => {
    handlers?.onConnectionState?.("waking")
    handlers?.onError(new Error("The Tuiscrib Service is waking up."))
    await setup.renderOnce()
  })
  const waking = setup.captureCharFrame()
  expect(waking).toContain("Waking the Tuiscrib Service…")
  expect(waking).not.toContain("Reconnecting…")

  await act(async () => {
    handlers?.onConnectionState?.("unavailable")
    handlers?.onError(new Error("The Tuiscrib Service is unavailable."))
    await setup.renderOnce()
  })
  const unavailable = setup.captureCharFrame()
  expect(unavailable).toContain("Service unavailable")
  expect(unavailable).not.toContain("Reconnecting…")

  await act(async () => {
    handlers?.onConnectionState?.("unauthorized")
    handlers?.onError(new Error("Your Terminal Session is invalid. Sign in again."))
    await setup.renderOnce()
  })
  const unauthorized = setup.captureCharFrame()
  expect(unauthorized).toContain("Session unauthorized")
  expect(unauthorized).not.toContain("Service unavailable")
})
