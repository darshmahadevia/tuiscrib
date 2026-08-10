import { afterEach, expect, test } from "bun:test"
import { createTerminalCapabilities, type TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { TerminalShell } from "@tuiscrib/terminal"

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

  expect(initialFrame).toContain("TUISCRIB")
  expect(initialFrame).toContain("MODE  NAVIGATE")
  expect(initialFrame).toContain("b boards")
  expect(initialFrame).toContain("? help")

  await act(async () => {
    activeSetup?.mockInput.pressKey("?")
    await activeSetup?.renderOnce()
  })

  const helpFrame = activeSetup.captureCharFrame()
  expect(helpFrame).toContain("Keyboard help")
  expect(helpFrame).toContain("Escape close")
  expect(helpFrame).toContain("Navigate mode")

  await act(async () => {
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
    await activeSetup?.flush()
  })

  const returnedFrame = await activeSetup.waitForFrame((frame) => !frame.includes("Keyboard help"))
  expect(returnedFrame).toContain("MODE  NAVIGATE")
  expect(returnedFrame).not.toContain("Keyboard help")
})

test("navigates the shell menu with keyboard hints and opens Boards", async () => {
  activeSetup = await testRender(<TerminalShell label="alpha" />, {
    width: 80,
    height: 24,
    kittyKeyboard: true,
  })

  await activeSetup.renderOnce()

  await act(async () => {
    activeSetup?.mockInput.pressKey("j")
    await activeSetup?.renderOnce()
  })

  expect(activeSetup.captureCharFrame()).toContain("› s sign in")

  await act(async () => {
    activeSetup?.mockInput.pressKey("k")
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  expect(activeSetup.captureCharFrame()).toContain("Board list")
  expect(activeSetup.captureCharFrame()).toContain("o open Board")
  expect(activeSetup.captureCharFrame()).toContain("c create Board")
  expect(activeSetup.captureCharFrame()).toContain("j join Board")
})

test("uses the reusable Register form with visible validation and status", async () => {
  activeSetup = await testRender(<TerminalShell label="alpha" />, {
    width: 80,
    height: 24,
    kittyKeyboard: true,
  })

  await activeSetup.renderOnce()

  await act(async () => {
    activeSetup?.mockInput.pressKey("r")
    await activeSetup?.renderOnce()
  })

  let frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Register User")
  expect(frame).toContain("Username")
  expect(frame).toContain("Password")
  expect(frame).toContain("Confirm password")
  expect(frame).toContain("Tab next field · Enter submit · Escape cancel")

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
  expect(frame).toContain("Status: registration form complete")
  expect(frame).toContain("MODE  NAVIGATE")
})

test("opens and cancels a reusable Board action confirmation", async () => {
  activeSetup = await testRender(<TerminalShell label="alpha" />, {
    width: 80,
    height: 24,
    kittyKeyboard: true,
  })

  await activeSetup.renderOnce()

  await act(async () => {
    activeSetup?.mockInput.pressKey("b")
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressKey("a")
    await activeSetup?.renderOnce()
  })

  let frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Board actions")
  expect(frame).toContain("d delete Board")

  await act(async () => {
    activeSetup?.mockInput.pressKey("d")
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Confirm Board action")
  expect(frame).toContain("y confirm · n cancel · Escape cancel")

  await act(async () => {
    activeSetup?.mockInput.pressKey("n")
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Board actions")
  expect(frame).toContain("Status: Action cancelled.")

  await act(async () => {
    activeSetup?.mockInput.pressKey("d")
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressKey("y")
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Board actions")
  expect(frame).toContain("Status: Board action confirmed.")
})

test("keeps Navigate and Edit mode presentation visibly distinct", async () => {
  activeSetup = await testRender(<TerminalShell label="alpha" />, {
    width: 80,
    height: 24,
    kittyKeyboard: true,
  })

  await activeSetup.renderOnce()

  await act(async () => {
    activeSetup?.mockInput.pressKey("b")
    await activeSetup?.renderOnce()
    activeSetup?.mockInput.pressKey("o")
    await activeSetup?.renderOnce()
  })

  let frame = activeSetup.captureCharFrame()
  expect(frame).toContain("Board canvas")
  expect(frame).toContain("MODE  NAVIGATE")
  expect(frame).toContain("Navigate mode · cursor at the stable origin")
  expect(frame).toContain("Enter edit")

  await act(async () => {
    activeSetup?.mockInput.pressEnter()
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("MODE  EDIT")
  expect(frame).toContain("Edit mode · keyboard text editing active")
  expect(frame).toContain("Escape leave Edit mode")
  expect(frame).not.toContain("MODE  NAVIGATE")

  await act(async () => {
    activeSetup?.mockInput.pressEscape()
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("MODE  NAVIGATE")

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

  expect(activeSetup.captureCharFrame()).toContain("MODE  NAVIGATE")
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
  expect(frame).not.toContain("MODE  NAVIGATE")

  await act(async () => {
    activeSetup?.resize(80, 24)
    await activeSetup?.renderOnce()
  })

  frame = activeSetup.captureCharFrame()
  expect(frame).toContain("MODE  NAVIGATE")
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
  expect(frame).toContain("Unicode · 256-color baseline · truecolor detected")
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
  expect(frame).toContain("Unicode · 256-color baseline")
  expect(frame).not.toContain("truecolor detected")
})
