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
import {
  createBoardAdministration,
  type BoardRateLimitOptions,
  type BoardPersistence,
} from "./boards.ts"

export type ServiceAppOptions = {
  persistence: Pick<Persistence, "healthCheck"> &
    Partial<AuthPersistence> &
    Partial<BoardPersistence>
  clock?: () => Date
  passwordHasher?: PasswordHasher
  credentialGenerator?: () => string
  boardIdGenerator?: () => string
  joinCodeGenerator?: () => string
  authRateLimit?: AuthRateLimitOptions
  boardRateLimit?: BoardRateLimitOptions
  networkKey?: (request: Request) => string
}

export function createServiceApp(options: ServiceAppOptions) {
  const app = new Hono()
  const clock = options.clock ?? (() => new Date())
  const authentication = createAuthenticationIfAvailable(options, clock)
  const boards = createBoardAdministrationIfAvailable(options, clock)

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

  app.get("/boards", async (context) => {
    if (!authentication || !boards) {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }

    const authenticated = await requireBoardUser(authentication, context.req.raw)
    if (authenticated.kind !== "success") {
      return context.json(authenticated.error, authenticated.status)
    }

    try {
      const filter = new URL(context.req.url).searchParams.get("filter") ?? ""
      const result = await boards.listBoards(authenticated.user, filter)
      return result.kind === "success"
        ? context.json(result.response, 200)
        : context.json(result.error, result.status)
    } catch {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }
  })

  app.post("/boards/join", async (context) => {
    if (!authentication || !boards) {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }

    const authenticated = await requireBoardUser(authentication, context.req.raw)
    if (authenticated.kind !== "success") {
      return context.json(authenticated.error, authenticated.status)
    }

    let input: unknown
    try {
      input = await context.req.json()
    } catch {
      input = undefined
    }

    try {
      const result = await boards.joinBoard(authenticated.user, input, {
        networkKey: options.networkKey?.(context.req.raw) ?? defaultNetworkKey(context.req.raw),
      })
      if (result.kind === "success") {
        return context.json(result.response, 201)
      }
      const response = context.json(result.error, result.status)
      if (result.error.retryAfterSeconds) {
        response.headers.set("Retry-After", String(result.error.retryAfterSeconds))
      }
      return response
    } catch {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }
  })

  app.post("/boards/:boardId/leave", async (context) => {
    if (!authentication || !boards) {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }

    const authenticated = await requireBoardUser(authentication, context.req.raw)
    if (authenticated.kind !== "success") {
      return context.json(authenticated.error, authenticated.status)
    }

    try {
      const result = await boards.leaveBoard(
        authenticated.user,
        context.req.param("boardId"),
      )
      return result.kind === "success"
        ? context.json(result.response, 200)
        : context.json(result.error, result.status)
    } catch {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }
  })

  app.post("/boards", async (context) => {
    if (!authentication || !boards) {
      return context.json(serviceErrorSchema.parse({ error: "service unavailable" }), 503)
    }

    const authenticated = await requireBoardUser(authentication, context.req.raw)
    if (authenticated.kind !== "success") {
      return context.json(authenticated.error, authenticated.status)
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

    try {
      const result = await boards.createBoard(authenticated.user, input)
      return result.kind === "success"
        ? context.json(result.response, 201)
        : context.json(result.error, result.status)
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

function createBoardAdministrationIfAvailable(
  options: ServiceAppOptions,
  clock: () => Date,
) {
  if (
    typeof options.persistence.createBoard !== "function" ||
    typeof options.persistence.listBoards !== "function"
  ) {
    return null
  }

  return createBoardAdministration({
    persistence: options.persistence as BoardPersistence,
    clock,
    boardIdGenerator: options.boardIdGenerator,
    joinCodeGenerator: options.joinCodeGenerator,
    rateLimit: options.boardRateLimit,
  })
}

type BoardAuthenticationService = NonNullable<ReturnType<typeof createAuthenticationIfAvailable>>

type BoardUserResult =
  | { kind: "success"; user: { id: number; username: string } }
  | { kind: "failure"; status: 401 | 503; error: ReturnType<typeof serviceErrorSchema.parse> }

async function requireBoardUser(
  authentication: BoardAuthenticationService,
  request: Request,
): Promise<BoardUserResult> {
  let result: Awaited<ReturnType<BoardAuthenticationService["authenticate"]>>
  try {
    result = await authentication.authenticate(readBearerCredential(request))
  } catch {
    return {
      kind: "failure",
      status: 503,
      error: serviceErrorSchema.parse({ error: "service unavailable" }),
    }
  }
  if (result === undefined) {
    return {
      kind: "failure",
      status: 503,
      error: serviceErrorSchema.parse({ error: "service unavailable" }),
    }
  }
  if (!result || "status" in result) {
    return {
      kind: "failure",
      status: 401,
      error: serviceErrorSchema.parse({
        error: "Your Terminal Session is invalid. Sign in again.",
        code: "invalid_session",
      }),
    }
  }

  return { kind: "success", user: result.user }
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
