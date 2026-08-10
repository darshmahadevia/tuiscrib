import { expect, test } from "bun:test"

import { createServiceApp } from "./app.ts"
import { hashCredential, TERMINAL_SESSION_INACTIVITY_MS } from "./auth.ts"

test("restores a valid Terminal Session through public HTTP and refreshes activity", async () => {
  const now = new Date("2026-08-10T00:00:00.000Z")
  const credential = "a".repeat(43)
  let restoredInput: {
    credentialHash: string
    now: Date
    expiresAt: Date
  } | undefined

  const app = createServiceApp({
    persistence: {
      healthCheck: async () => ({ database: "ready" }),
      findUserByUsername: async () => null,
      registerUser: async () => null,
      createTerminalSession: async () => ({ sessionId: 1 }),
      authenticateTerminalSession: async (input) => {
        restoredInput = input
        return { user: { username: "ada_lovelace" } }
      },
      revokeTerminalSession: async () => undefined,
    },
    clock: () => now,
  })

  const response = await app.request("http://tuiscrib.test/auth/session", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ user: { username: "ada_lovelace" } })
  expect(restoredInput).toEqual({
    credentialHash: hashCredential(credential),
    now,
    expiresAt: new Date(now.getTime() + TERMINAL_SESSION_INACTIVITY_MS),
  })
})

test("expired Terminal Sessions return a clear nondisclosing error", async () => {
  const credential = "b".repeat(43)
  const app = createServiceApp({
    persistence: {
      healthCheck: async () => ({ database: "ready" }),
      findUserByUsername: async () => null,
      registerUser: async () => null,
      createTerminalSession: async () => ({ sessionId: 1 }),
      authenticateTerminalSession: async () => ({ status: "expired" }),
      revokeTerminalSession: async () => undefined,
    },
  })

  const response = await app.request("http://tuiscrib.test/auth/session", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  })

  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({
    error: "Your Terminal Session expired after 30 days of inactivity. Sign in again.",
    code: "session_expired",
  })
})

test("malformed Terminal Session credentials fail closed without a credential-bearing error", async () => {
  const credential = "not-a-session"
  let persistenceCalled = false
  const app = createServiceApp({
    persistence: {
      healthCheck: async () => ({ database: "ready" }),
      findUserByUsername: async () => null,
      registerUser: async () => null,
      createTerminalSession: async () => ({ sessionId: 1 }),
      authenticateTerminalSession: async () => {
        persistenceCalled = true
        return null
      },
      revokeTerminalSession: async () => undefined,
    },
  })

  const response = await app.request("http://tuiscrib.test/auth/session", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  })
  const body = await response.text()

  expect(response.status).toBe(401)
  expect(body).toContain("Your Terminal Session is invalid")
  expect(body).not.toContain(credential)
  expect(persistenceCalled).toBe(false)
})

test("sign-out revokes the Terminal Session through public HTTP", async () => {
  const credential = "c".repeat(43)
  let revokedInput: { credentialHash: string; now: Date } | undefined
  const now = new Date("2026-08-10T00:00:00.000Z")
  const app = createServiceApp({
    persistence: {
      healthCheck: async () => ({ database: "ready" }),
      findUserByUsername: async () => null,
      registerUser: async () => null,
      createTerminalSession: async () => ({ sessionId: 1 }),
      authenticateTerminalSession: async () => ({ status: "revoked" }),
      revokeTerminalSession: async (input) => {
        revokedInput = input
      },
    },
    clock: () => now,
  })

  const response = await app.request("http://tuiscrib.test/auth/sign-out", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: "signed_out" })
  expect(revokedInput).toEqual({
    credentialHash: hashCredential(credential),
    now,
  })
})

test("registration returns one opaque Terminal Session through public HTTP", async () => {
  let storedPasswordHash = ""
  let storedCredentialHash = ""

  const app = createServiceApp({
    persistence: {
      healthCheck: async () => ({ database: "ready" }),
      findUserByUsername: async () => null,
      registerUser: async (input) => {
        storedPasswordHash = input.passwordHash
        storedCredentialHash = input.credentialHash
        return {
          user: { id: 1, username: input.username },
          sessionId: 1,
        }
      },
      createTerminalSession: async () => ({ sessionId: 2 }),
    },
    passwordHasher: {
      hash: async () => "$argon2id$test-hash",
      verify: async () => true,
    },
    credentialGenerator: () => "opaque-session",
  })

  const response = await app.request("http://tuiscrib.test/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "ada_lovelace",
      password: "correct horse",
      confirmation: "correct horse",
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    user: { username: "ada_lovelace" },
    sessionCredential: "opaque-session",
  })
  expect(storedPasswordHash).toStartWith("$argon2id$")
  expect(storedPasswordHash).not.toContain("correct horse")
  expect(storedCredentialHash).not.toBe("opaque-session")
  expect(storedCredentialHash).toHaveLength(64)
})

test("default password handling stores a verifiable Argon2id hash and only a credential hash", async () => {
  let storedPasswordHash = ""
  let storedCredentialHash = ""
  const app = createServiceApp({
    persistence: {
      healthCheck: async () => ({ database: "ready" }),
      findUserByUsername: async () => null,
      registerUser: async (input) => {
        storedPasswordHash = input.passwordHash
        storedCredentialHash = input.credentialHash
        return { user: { id: 1, username: input.username }, sessionId: 1 }
      },
      createTerminalSession: async () => ({ sessionId: 2 }),
    },
    credentialGenerator: () => "opaque-session",
  })

  const response = await app.request("http://tuiscrib.test/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.10" },
    body: JSON.stringify({
      username: "grace_hopper",
      password: "correct horse",
      confirmation: "correct horse",
    }),
  })

  expect(response.status).toBe(201)
  expect(storedPasswordHash).toStartWith("$argon2id$")
  expect(storedPasswordHash).not.toContain("correct horse")
  expect(await Bun.password.verify("correct horse", storedPasswordHash)).toBe(true)
  expect(storedCredentialHash).toBe("c2fc539b01d727ea2c4f2a42565f07666160db60c7e11fd5686b741c52382d51")
})

test("authentication attempts are rate-limited by identity and network", async () => {
  let now = 0
  const app = createServiceApp({
    persistence: {
      healthCheck: async () => ({ database: "ready" }),
      findUserByUsername: async () => null,
      registerUser: async () => null,
      createTerminalSession: async () => ({ sessionId: 1 }),
    },
    clock: () => new Date(now),
    authRateLimit: { maxAttempts: 2, windowMs: 1_000 },
  })

  const request = () =>
    app.request("http://tuiscrib.test/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.20" },
      body: JSON.stringify({ username: "missing_user", password: "wrong password" }),
    })

  expect((await request()).status).toBe(401)
  expect((await request()).status).toBe(401)
  const limited = await request()
  expect(limited.status).toBe(429)
  expect(limited.headers.get("retry-after")).toBe("1")
  expect(await limited.json()).toEqual({
    error: "Too many authentication attempts. Try again later.",
    code: "rate_limited",
    retryAfterSeconds: 1,
  })

  now = 1_000
  expect((await request()).status).toBe(401)
})
