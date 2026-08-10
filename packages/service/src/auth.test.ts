import { expect, test } from "bun:test"

import { createServiceApp } from "./app.ts"

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
