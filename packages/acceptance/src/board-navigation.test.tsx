import { afterEach, expect, test } from "bun:test"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import {
  TerminalShell,
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

async function waitForFrame(
  predicate: (frame: string) => boolean,
): Promise<string> {
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

function createAuthClient(): AuthClient {
  return {
    register: async () => {
      throw new Error("register was not expected")
    },
    signIn: async () => {
      throw new Error("sign-in was not expected")
    },
    restore: async () => ({ user: { username: "board_owner" } }),
    signOut: async () => ({ status: "signed_out" }),
  }
}

function createCredentialStore(credential: string): CredentialStore {
  return {
    filePath: "memory://board-navigation/session",
    load: async () => credential,
    save: async () => undefined,
    remove: async () => undefined,
  }
}

test("selects the Board targeted by Board actions without reopening its canvas", async () => {
  const credential = "n".repeat(43)
  const alpha = {
    id: "Alpha3nW8kM2pR5sT9vY4aB",
    name: "Alpha",
    role: "owner" as const,
  }
  const beta = {
    id: "BetaQx7u3nW8kM2pR5sT9vY4",
    name: "Beta",
    role: "owner" as const,
  }
  let renamedBoardId: string | undefined
  const boardClient: BoardClient = {
    createBoard: async () => {
      throw new Error("create Board was not expected")
    },
    listBoards: async () => ({ boards: [alpha, beta] }),
    joinBoard: async () => {
      throw new Error("join Board was not expected")
    },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => ({ status: "deleted" }),
    renameBoard: async (_nextCredential, boardId, input) => {
      renamedBoardId = boardId
      return { board: { ...alpha, name: input.name } }
    },
    rotateJoinCode: async () => {
      throw new Error("rotate Join Code was not expected")
    },
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        authClient={createAuthClient()}
        boardClient={boardClient}
        credentialStore={createCredentialStore(credential)}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })

  await waitForFrame((frame) => frame.includes("Alpha · Owner"))
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      activeSetup?.mockInput.pressArrow("down")
    }
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((frame) => frame.includes("Selected Board: Beta · Owner"))

  await act(async () => {
    activeSetup?.mockInput.pressArrow("left")
    await activeSetup?.renderOnce()
  })
  const selectedFrame = await waitForFrame(
    (frame) => frame.includes("Selected Board: Alpha · Owner"),
  )
  expect(selectedFrame).toContain("←→ select Board")

  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((frame) => frame.includes("Rename Board"))
  await act(async () => {
    await activeSetup?.mockInput.typeText("Alpha renamed")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  await waitForFrame((frame) => frame.includes("Board renamed to \"Alpha renamed\"."))
  expect(renamedBoardId).toBe(alpha.id)
})

test("reopens a newly created Board's Join Code from Board actions", async () => {
  const credential = "j".repeat(43)
  const joinCode = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-45"
  const createdBoard = {
    id: "Created3nW8kM2pR5sT9vY4",
    name: "Planning",
    role: "owner" as const,
  }
  let boards: (typeof createdBoard)[] = []
  const boardClient: BoardClient = {
    createBoard: async () => {
      boards = [createdBoard]
      return { board: createdBoard, joinCode }
    },
    listBoards: async () => ({ boards }),
    joinBoard: async () => {
      throw new Error("join Board was not expected")
    },
    leaveBoard: async () => ({ status: "left" }),
    deleteBoard: async () => ({ status: "deleted" }),
    renameBoard: async () => {
      throw new Error("rename Board was not expected")
    },
    rotateJoinCode: async () => {
      throw new Error("rotate Join Code was not expected")
    },
  }

  await act(async () => {
    activeSetup = await testRender(
      <TerminalShell
        authClient={createAuthClient()}
        boardClient={boardClient}
        credentialStore={createCredentialStore(credential)}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    await activeSetup.renderOnce()
  })

  await waitForFrame((frame) => frame.includes("No Memberships match this filter."))
  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((frame) => frame.includes("Create Board"))
  await act(async () => {
    await activeSetup?.mockInput.typeText("Planning")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((frame) => frame.includes(joinCode))

  await act(async () => {
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
  })
  const reopenedList = await waitForFrame(
    (frame) => frame.includes("Planning · Owner") && !frame.includes(joinCode),
  )
  expect(reopenedList).not.toContain(joinCode)

  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })
  await waitForFrame((frame) => frame.includes("Board actions"))
  await act(async () => {
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressArrow("down")
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  const codeFrame = await waitForFrame((frame) => frame.includes(joinCode))
  expect(codeFrame).toContain("Board created")
  expect(codeFrame).toContain("Planning")
  expect(codeFrame).toContain("[ c ] Copy")
  expect(codeFrame).not.toContain("create Board")
  expect(codeFrame).not.toContain("join Board")
})
