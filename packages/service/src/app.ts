import { Hono } from "hono"
import type { Context } from "hono"

import {
  healthRequestSchema,
  healthResponseSchema,
  serviceErrorSchema,
} from "@tuiscrib/contracts"
import type { Persistence } from "@tuiscrib/persistence"

import {
  createAuthenticationService,
  type AuthOperationResult,
  type AuthPersistence,
  type AuthRateLimitOptions,
  type PasswordHasher,
} from "./auth.ts"

export type ServiceAppOptions = {
  persistence: Pick<Persistence, "healthCheck"> & Partial<AuthPersistence>
  clock?: () => Date
  passwordHasher?: PasswordHasher
  credentialGenerator?: () => string
  authRateLimit?: AuthRateLimitOptions
  networkKey?: (request: Request) => string
}

export function createServiceApp(options: ServiceAppOptions) {
  const app = new Hono()
  const clock = options.clock ?? (() => new Date())
  const authentication = createAuthenticationIfAvailable(options, clock)

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

  app.post("/auth/register", async (context) => {
    return handleAuthenticationRequest(context, authentication, "register", options.networkKey)
  })

  app.post("/auth/sign-in", async (context) => {
    return handleAuthenticationRequest(context, authentication, "signIn", options.networkKey)
  })

  app.post("/auth/session", async (context) => {
    if (!authentication) {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }

    try {
      const result = await authentication.restore(readBearerCredential(context.req.raw))
      return result.kind === "success"
        ? context.json(result.response, 200)
        : context.json(result.error, result.status)
    } catch {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }
  })

  app.post("/auth/sign-out", async (context) => {
    if (!authentication) {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }

    try {
      const result = await authentication.signOut(readBearerCredential(context.req.raw))
      return result.kind === "success"
        ? context.json(result.response, 200)
        : context.json(result.error, result.status)
    } catch {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }
  })

  return app
}

function createAuthenticationIfAvailable(
  options: ServiceAppOptions,
  clock: () => Date,
) {
  if (
    typeof options.persistence.findUserByUsername !== "function" ||
    typeof options.persistence.registerUser !== "function" ||
    typeof options.persistence.createTerminalSession !== "function"
  ) {
    return null
  }

  return createAuthenticationService({
    persistence: options.persistence as AuthPersistence,
    clock,
    passwordHasher: options.passwordHasher,
    credentialGenerator: options.credentialGenerator,
    rateLimit: options.authRateLimit,
  })
}

async function handleAuthenticationRequest(
  context: Context,
  authentication: ReturnType<typeof createAuthenticationIfAvailable>,
  operation: "register" | "signIn",
  networkKey: ((request: Request) => string) | undefined,
) {
  if (!authentication) {
    return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
  }

  let input: unknown
  try {
    input = await context.req.json()
  } catch {
    return context.json(
      serviceErrorSchema.parse({
        error: "Check the highlighted fields.",
        code: "invalid_input",
        fieldErrors: { form: "Request body must be valid JSON." },
      }),
      400,
    )
  }

  let result: AuthOperationResult
  try {
    result = await authentication[operation](input, {
      networkKey: networkKey?.(context.req.raw) ?? defaultNetworkKey(context.req.raw),
    })
  } catch {
    return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
  }

  if (result.kind === "success") {
    return context.json(result.response, operation === "register" ? 201 : 200)
  }

  const response = context.json(result.error, result.status)
  if (result.error.retryAfterSeconds) {
    response.headers.set("Retry-After", String(result.error.retryAfterSeconds))
  }
  return response
}

function defaultNetworkKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return (
    forwarded ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "unknown"
  )
}

function readBearerCredential(request: Request): string | null {
  const authorization = request.headers.get("authorization")
  if (!authorization) {
    return null
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization)
  return match?.[1] ?? null
}
