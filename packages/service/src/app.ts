import { Hono } from "hono"

import {
  healthRequestSchema,
  healthResponseSchema,
  serviceErrorSchema,
} from "@tuiscrib/contracts"
import type { Persistence } from "@tuiscrib/persistence"

export type ServiceAppOptions = {
  persistence: Pick<Persistence, "healthCheck">
  clock?: () => Date
}

export function createServiceApp(options: ServiceAppOptions) {
  const app = new Hono()
  const clock = options.clock ?? (() => new Date())

  app.get("/health", async (context) => {
    const request = healthRequestSchema.safeParse(
      Object.fromEntries(new URL(context.req.url).searchParams.entries()),
    )

    if (!request.success) {
      return context.json(serviceErrorSchema.parse({ error: "invalid readiness probe" }), 400)
    }

    try {
      await options.persistence.healthCheck()
      const response = healthResponseSchema.parse({
        status: "ready",
        service: "tuiscrib-service",
        database: "ready",
        checkedAt: clock().toISOString(),
      })
      return context.json(response, 200)
    } catch {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }
  })

  return app
}
