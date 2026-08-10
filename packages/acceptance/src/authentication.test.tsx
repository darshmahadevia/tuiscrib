import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { act } from "react"

import { AcceptanceHarness, type TerminalClient } from "./harness.tsx"

describe("Tuiscrib terminal authentication", () => {
  let harness: AcceptanceHarness | null = null

  beforeAll(async () => {
    harness = await AcceptanceHarness.start()
  }, { timeout: 120_000 })

  afterAll(async () => {
    await harness?.dispose()
  }, { timeout: 30_000 })

  async function waitForFrame(
    client: TerminalClient,
    predicate: (frame: string) => boolean,
  ): Promise<string> {
    let lastFrame = ""
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await act(async () => {
        await Bun.sleep(10)
        await client.setup.renderOnce()
      })
      const frame = client.setup.captureCharFrame()
      lastFrame = frame
      if (predicate(frame)) {
        return frame
      }
    }

    throw new Error(`Timed out waiting for ${client.label} rendered frame\n${lastFrame}`)
  }

  test("renders registration and sign-in success and nondisclosing rejection states", async () => {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    const client = await harness.addShellClient("auth")
    await client.setup.renderOnce()

    await act(async () => {
      client.setup.mockInput.pressKey("r")
      await client.setup.renderOnce()
    })
    expect(client.setup.captureCharFrame()).toContain("Password recovery is unavailable")

    await act(async () => {
      await client.setup.mockInput.typeText("Bad")
      client.setup.mockInput.pressTab()
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("short")
      client.setup.mockInput.pressTab()
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("short")
      client.setup.mockInput.pressEnter()
      await client.setup.renderOnce()
    })

    let frame = await waitForFrame(client, (value) => value.includes("Error:"))
    expect(frame).toContain("ASCII letters")
    expect(frame).not.toContain("short")

    await act(async () => {
      client.setup.mockInput.pressEscape()
      await client.setup.renderOnce()
      client.setup.mockInput.pressKey("r")
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("ada_lovelace")
      client.setup.mockInput.pressTab()
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("correct horse")
      client.setup.mockInput.pressTab()
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("correct horse")
      client.setup.mockInput.pressEnter()
      await client.setup.renderOnce()
    })

    frame = await waitForFrame(client, (value) => value.includes("Registration complete"))
    expect(frame).toContain("Session ready")
    expect(frame).not.toContain("correct horse")

    await act(async () => {
      client.setup.mockInput.pressKey("r")
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("ada_lovelace")
      client.setup.mockInput.pressTab()
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("correct horse")
      client.setup.mockInput.pressTab()
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("correct horse")
      client.setup.mockInput.pressEnter()
      await client.setup.renderOnce()
    })

    frame = await waitForFrame(client, (value) => value.includes("Error:"))
    expect(frame).toContain("That username is unavailable.")
    expect(frame).not.toContain("correct horse")

    await act(async () => {
      client.setup.mockInput.pressEscape()
      await client.setup.renderOnce()
      client.setup.mockInput.pressKey("s")
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("ada_lovelace")
      client.setup.mockInput.pressTab()
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("wrong password")
      client.setup.mockInput.pressEnter()
      await client.setup.renderOnce()
    })

    frame = await waitForFrame(client, (value) => value.includes("Error:"))
    expect(frame).toContain("Username or password is incorrect.")
    expect(frame).not.toContain("wrong password")

    await act(async () => {
      client.setup.mockInput.pressEscape()
      await client.setup.renderOnce()
      client.setup.mockInput.pressKey("s")
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("ada_lovelace")
      client.setup.mockInput.pressTab()
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("correct horse")
      client.setup.mockInput.pressEnter()
      await client.setup.renderOnce()
    })

    frame = await waitForFrame(client, (value) => value.includes("Sign-in complete"))
    expect(frame).toContain("Session ready")
    expect(frame).not.toContain("correct horse")
  }, 30_000)
})
