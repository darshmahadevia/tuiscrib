import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { act } from "react"

import { TERMINAL_SESSION_INACTIVITY_MS } from "@tuiscrib/service"

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
    let matchedFrame: string | undefined
    await act(async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await Bun.sleep(10)
        await client.setup.renderOnce()
        const frame = client.setup.captureCharFrame()
        lastFrame = frame
        if (predicate(frame)) {
          matchedFrame = frame
          return
        }
      }
    })

    if (matchedFrame !== undefined) {
      return matchedFrame
    }

    throw new Error(`Timed out waiting for ${client.label} rendered frame\n${lastFrame}`)
  }

  test("renders registration and sign-in success and nondisclosing rejection states", async () => {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    const client = await harness.addShellClient("auth")

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

  test("restores, revokes, and expires a Terminal Session through real HTTP and frames", async () => {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }

    const client = await harness.addShellClient("session-lifecycle")
    const credentialStore = client.credentialStore
    if (!credentialStore) {
      throw new Error("acceptance credential store did not start")
    }

    await act(async () => {
      client.setup.mockInput.pressKey("r")
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("grace_hopper")
      client.setup.mockInput.pressTab()
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("correct horse")
      client.setup.mockInput.pressTab()
      await client.setup.renderOnce()
      await client.setup.mockInput.typeText("correct horse")
      client.setup.mockInput.pressEnter()
      await client.setup.renderOnce()
    })

    let frame = await waitForFrame(client, (value) => value.includes("Registration complete"))
    expect(frame).not.toContain("correct horse")
    const firstCredential = await credentialStore.load()
    expect(firstCredential).not.toBeNull()

    harness.clock.advance(TERMINAL_SESSION_INACTIVITY_MS - 1_000)
    await act(async () => {
      client.setup.renderer.destroy()
    })
    const restored = await harness.addShellClient("restored", credentialStore)
    frame = await waitForFrame(restored, (value) => value.includes("Terminal Session restored"))
    expect(frame).toContain("grace_hopper")
    expect(frame).not.toContain(firstCredential ?? "")

    await act(async () => {
      restored.setup.mockInput.pressKey("x")
      await restored.setup.renderOnce()
    })
    frame = await waitForFrame(restored, (value) => value.includes("Signed out"))
    expect(frame).toContain("Terminal Session revoked")
    expect(await credentialStore.load()).toBeNull()

    const revokedResponse = await fetch(`${harness.baseUrl}/auth/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstCredential}` },
    })
    expect(revokedResponse.status).toBe(401)
    expect(await revokedResponse.json()).toEqual({
      error: "Your Terminal Session was revoked. Sign in again.",
      code: "session_revoked",
    })

    await act(async () => {
      restored.setup.mockInput.pressKey("s")
      await restored.setup.renderOnce()
      await restored.setup.mockInput.typeText("grace_hopper")
      restored.setup.mockInput.pressTab()
      await restored.setup.renderOnce()
      await restored.setup.mockInput.typeText("correct horse")
      restored.setup.mockInput.pressEnter()
      await restored.setup.renderOnce()
    })
    frame = await waitForFrame(restored, (value) => value.includes("Sign-in complete"))
    const secondCredential = await credentialStore.load()
    expect(secondCredential).not.toBeNull()

    await act(async () => {
      restored.setup.renderer.destroy()
    })
    harness.clock.advance(TERMINAL_SESSION_INACTIVITY_MS)
    const expired = await harness.addShellClient("expired", credentialStore)
    frame = await waitForFrame(expired, (value) => value.includes("expired after 30 days"))
    expect(frame).toContain("Sign in again")
    expect(frame).not.toContain(secondCredential ?? "")
    expect(await credentialStore.load()).toBeNull()
  }, 60_000)
})
