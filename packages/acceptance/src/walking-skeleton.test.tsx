import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { act } from "react"

import { AcceptanceHarness, type TerminalClient } from "./harness.tsx"

describe("Tuiscrib walking skeleton", () => {
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
    synchronizeNetwork: () => Promise<void>,
  ): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await act(async () => {
        await synchronizeNetwork()
      })
      await client.setup.renderOnce()
      const frame = client.setup.captureCharFrame()
      if (predicate(frame)) {
        return frame
      }
    }

    throw new Error(`Timed out waiting for ${client.label} rendered frame`)
  }

  async function waitForReady(
    client: TerminalClient,
    synchronizeNetwork: () => Promise<void>,
  ): Promise<string> {
    return waitForFrame(client, (frame) => {
      return (
        frame.includes("Service: tuiscrib-service") &&
        frame.includes("Database: ready") &&
        frame.includes(`Terminal client: ${client.label}`)
      )
    }, synchronizeNetwork)
  }

  test("migrates PostgreSQL and renders one real readiness result in two terminal clients", async () => {
    if (!harness) {
      throw new Error("acceptance harness did not start")
    }
    const activeHarness = harness

    const first = await activeHarness.addClient("alpha")
    const second = await activeHarness.addClient("bravo")
    const synchronizeNetwork = async () => {
      const response = await fetch(`${activeHarness.baseUrl}/health?probe=readiness`)
      await response.arrayBuffer()
    }

    const firstFrame = await waitForReady(first, synchronizeNetwork)
    const secondFrame = await waitForReady(second, synchronizeNetwork)

    expect(firstFrame).toContain("Service: tuiscrib-service")
    expect(firstFrame).toContain("Database: ready")
    expect(firstFrame).toContain("Checked at: 2026-08-10T00:00:00.000Z")
    expect(secondFrame).toContain("Service: tuiscrib-service")
    expect(secondFrame).toContain("Database: ready")

    await act(async () => {
      first.setup.mockInput.pressKey("r")
      await synchronizeNetwork()
    })
    const refreshedFrame = await waitForFrame(
      first,
      (frame) => frame.includes("Database: ready"),
      synchronizeNetwork,
    )
    expect(refreshedFrame).toContain("r refresh · q quit")
    expect(activeHarness.clock.now()).toBe(Date.parse("2026-08-10T00:00:00.000Z"))
  }, 30_000)
})
