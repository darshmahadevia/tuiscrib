import { describe, expect, test } from "bun:test"

import { createServiceApp } from "./app.ts"

describe("public health interaction", () => {
  test("rejects an invalid readiness probe through Hono", async () => {
    const app = createServiceApp({
      persistence: {
        healthCheck: async () => ({ database: "ready" }),
      },
    })

    const response = await app.request("http://tuiscrib.test/health?probe=debug")

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid readiness probe" })
  })

  test("renders a contract-shaped ready response", async () => {
    const app = createServiceApp({
      persistence: {
        healthCheck: async () => ({ database: "ready" }),
      },
      clock: () => new Date("2026-08-10T00:00:00.000Z"),
    })

    const response = await app.request("http://tuiscrib.test/health")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "ready",
      service: "tuiscrib-service",
      database: "ready",
      checkedAt: "2026-08-10T00:00:00.000Z",
    })
  })
})
