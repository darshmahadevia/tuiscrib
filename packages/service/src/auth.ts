import { createHash, randomBytes } from "node:crypto"

import {
  authResponseSchema,
  registerRequestSchema,
  serviceErrorSchema,
  signInRequestSchema,
  type AuthResponse,
  type ServiceError,
} from "@tuiscrib/contracts"
import type {
  AuthUserRecord,
  Persistence,
  RegisterUserInput,
} from "@tuiscrib/persistence"

export const TERMINAL_SESSION_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$ddbcyBcbAcagei7wSkZFiouX6TqnUQHmTyS5mxGCzeM$+3OIaFatZ3n6LtMhUlfWbgJyNp7h8/oIsLK+LzZO+WI"

export type PasswordHasher = {
  hash(password: string): Promise<string>
  verify(password: string, passwordHash: string): Promise<boolean>
}

export type AuthPersistence = Pick<
  Persistence,
  "findUserByUsername" | "registerUser" | "createTerminalSession"
>

export type AuthRateLimitOptions = {
  maxAttempts?: number
  windowMs?: number
  now?: () => number
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number }

type RateLimitBucket = {
  startedAt: number
  attempts: number
}

export class AuthRateLimiter {
  private readonly maxAttempts: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly buckets = new Map<string, RateLimitBucket>()

  constructor(options: AuthRateLimitOptions = {}) {
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5))
    this.windowMs = Math.max(1, Math.floor(options.windowMs ?? 60_000))
    this.now = options.now ?? (() => Date.now())
  }

  consume(keys: string[]): RateLimitResult {
    const uniqueKeys = [...new Set(keys.filter((key) => key.length > 0))]
    const now = this.now()
    let retryAfterMs = 0

    for (const key of uniqueKeys) {
      const bucket = this.currentBucket(key, now)
      if (bucket.attempts >= this.maxAttempts) {
        retryAfterMs = Math.max(retryAfterMs, this.windowMs - (now - bucket.startedAt))
      }
    }

    if (retryAfterMs > 0) {
      return { allowed: false, retryAfterMs }
    }

    for (const key of uniqueKeys) {
      const bucket = this.currentBucket(key, now)
      bucket.attempts += 1
    }

    return { allowed: true }
  }

  private currentBucket(key: string, now: number): RateLimitBucket {
    const existing = this.buckets.get(key)
    if (existing && now - existing.startedAt < this.windowMs) {
      return existing
    }

    const bucket = { startedAt: now, attempts: 0 }
    this.buckets.set(key, bucket)
    return bucket
  }
}

export type AuthenticationOptions = {
  persistence: AuthPersistence
  clock?: () => Date
  passwordHasher?: PasswordHasher
  credentialGenerator?: () => string
  rateLimiter?: AuthRateLimiter
  rateLimit?: AuthRateLimitOptions
}

export type AuthOperationResult =
  | { kind: "success"; response: AuthResponse }
  | { kind: "failure"; status: 400 | 401 | 409 | 429; error: ServiceError }

export type AuthRequestSignals = {
  networkKey: string
}

const defaultPasswordHasher: PasswordHasher = {
  hash: (password) => Bun.password.hash(password, { algorithm: "argon2id" }),
  verify: (password, passwordHash) => Bun.password.verify(password, passwordHash),
}

export function createCredential(): string {
  return randomBytes(32).toString("base64url")
}

export function hashCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex")
}

export function createAuthenticationService(options: AuthenticationOptions) {
  const clock = options.clock ?? (() => new Date())
  const passwordHasher = options.passwordHasher ?? defaultPasswordHasher
  const credentialGenerator = options.credentialGenerator ?? createCredential
  const rateLimiter =
    options.rateLimiter ??
    new AuthRateLimiter({
      ...options.rateLimit,
      now: options.rateLimit?.now ?? (() => clock().getTime()),
    })

  return {
    async register(input: unknown, signals: AuthRequestSignals): Promise<AuthOperationResult> {
      const rateLimitResult = consumeRateLimit(rateLimiter, input, signals)
      if (!rateLimitResult.allowed) {
        return rateLimited(rateLimitResult.retryAfterMs)
      }

      const parsed = registerRequestSchema.safeParse(input)
      if (!parsed.success) {
        return invalidInput(parsed.error)
      }

      const passwordHash = await passwordHasher.hash(parsed.data.password)
      assertArgon2idHash(passwordHash)

      const credential = credentialGenerator()
      const now = clock()
      const registerInput: RegisterUserInput = {
        username: parsed.data.username,
        passwordHash,
        credentialHash: hashCredential(credential),
        now,
        expiresAt: new Date(now.getTime() + TERMINAL_SESSION_INACTIVITY_MS),
      }
      const registered = await options.persistence.registerUser(registerInput)

      if (!registered) {
        return {
          kind: "failure",
          status: 409,
          error: serviceErrorSchema.parse({
            error: "That username is unavailable.",
            code: "username_unavailable",
          }),
        }
      }

      return success({
        user: { username: registered.user.username },
        sessionCredential: credential,
      })
    },

    async signIn(input: unknown, signals: AuthRequestSignals): Promise<AuthOperationResult> {
      const rateLimitResult = consumeRateLimit(rateLimiter, input, signals)
      if (!rateLimitResult.allowed) {
        return rateLimited(rateLimitResult.retryAfterMs)
      }

      const parsed = signInRequestSchema.safeParse(input)
      if (!parsed.success) {
        return invalidInput(parsed.error)
      }

      const user = await options.persistence.findUserByUsername(parsed.data.username)
      const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH
      const passwordMatches = await verifyPassword(passwordHasher, parsed.data.password, passwordHash)

      if (!user || !passwordMatches) {
        return {
          kind: "failure",
          status: 401,
          error: serviceErrorSchema.parse({
            error: "Username or password is incorrect.",
            code: "invalid_credentials",
          }),
        }
      }

      const credential = credentialGenerator()
      const now = clock()
      await options.persistence.createTerminalSession({
        userId: user.id,
        credentialHash: hashCredential(credential),
        now,
        expiresAt: new Date(now.getTime() + TERMINAL_SESSION_INACTIVITY_MS),
      })

      return success({
        user: { username: user.username },
        sessionCredential: credential,
      })
    },
  }
}

function consumeRateLimit(
  limiter: AuthRateLimiter,
  input: unknown,
  signals: AuthRequestSignals,
): RateLimitResult {
  const keys = [`network:${signals.networkKey || "unknown"}`]
  const username = getCandidateUsername(input)
  if (username) {
    keys.push(`username:${username}`)
  }
  return limiter.consume(keys)
}

function getCandidateUsername(input: unknown): string {
  if (!input || typeof input !== "object" || !("username" in input)) {
    return ""
  }

  const username = (input as { username?: unknown }).username
  return typeof username === "string" ? username.slice(0, 64) : ""
}

function success(response: AuthResponse): AuthOperationResult {
  return { kind: "success", response: authResponseSchema.parse(response) }
}

function invalidInput(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): AuthOperationResult {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form")
    fieldErrors[field] ??= issue.message
  }

  return {
    kind: "failure",
    status: 400,
    error: serviceErrorSchema.parse({
      error: "Check the highlighted fields.",
      code: "invalid_input",
      fieldErrors,
    }),
  }
}

function rateLimited(retryAfterMs: number): AuthOperationResult {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return {
    kind: "failure",
    status: 429,
    error: serviceErrorSchema.parse({
      error: "Too many authentication attempts. Try again later.",
      code: "rate_limited",
      retryAfterSeconds,
    }),
  }
}

function assertArgon2idHash(passwordHash: string): void {
  if (!passwordHash.startsWith("$argon2id$")) {
    throw new Error("password hashing algorithm is not Argon2id")
  }
}

async function verifyPassword(
  passwordHasher: PasswordHasher,
  password: string,
  passwordHash: string,
): Promise<boolean> {
  try {
    return await passwordHasher.verify(password, passwordHash)
  } catch {
    return false
  }
}

export type { AuthUserRecord }
