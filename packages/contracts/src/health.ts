import { z } from "zod"

export const healthRequestSchema = z.object({
  probe: z.literal("readiness").default("readiness"),
})

export const healthResponseSchema = z.object({
  status: z.literal("ready"),
  service: z.literal("tuiscrib-service"),
  database: z.literal("ready"),
  checkedAt: z.iso.datetime(),
})

export const serviceErrorSchema = z.object({
  error: z.string().min(1),
  code: z.string().min(1).optional(),
  fieldErrors: z.record(z.string(), z.string()).optional(),
  retryAfterSeconds: z.number().int().positive().optional(),
})

export type HealthRequest = z.infer<typeof healthRequestSchema>
export type HealthResponse = z.infer<typeof healthResponseSchema>
export type ServiceError = z.infer<typeof serviceErrorSchema>
