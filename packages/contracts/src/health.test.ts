import { describe, expect, test } from "bun:test"

import {
  healthRequestSchema,
  healthResponseSchema,
} from "./health.ts"

describe("health contract", () => {
  test("defaults the public readiness probe", () => {
    expect(healthRequestSchema.parse({})).toEqual({ probe: "readiness" })
  })

  test("rejects an unsupported public probe", () => {
    expect(() => healthRequestSchema.parse({ probe: "debug" })).toThrow()
  })

  test("accepts only a complete ready response", () => {
    expect(
      healthResponseSchema.parse({
        status: "ready",
        service: "tuiscrib-service",
        database: "ready",
        checkedAt: "2026-08-10T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "ready", database: "ready" })
  })
})
