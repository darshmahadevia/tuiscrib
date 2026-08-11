import { expect, test } from "bun:test"

import {
  loadServiceEnvironment,
  redactServiceError,
} from "./config.ts"

test("rejects missing DATABASE_URL without echoing a credential-bearing value", () => {
  const secretDatabaseUrl = "postgresql://tuiscrib:do-not-log@db.example.test/tuiscrib"

  expect(() => loadServiceEnvironment({
    PORT: "3000",
    TUISCRIB_REQUIRE_POOLED_DATABASE_URL: "true",
  })).toThrow("DATABASE_URL")

  expect(() => loadServiceEnvironment({
    DATABASE_URL: secretDatabaseUrl,
    PORT: "not-a-port",
  })).toThrow("PORT")

  try {
    loadServiceEnvironment({
      DATABASE_URL: secretDatabaseUrl,
      PORT: "not-a-port",
    })
  } catch (error) {
    expect(String(error)).not.toContain("do-not-log")
    expect(String(error)).not.toContain(secretDatabaseUrl)
  }
})

test("requires a pooled Neon endpoint for hosted configuration", () => {
  expect(() => loadServiceEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://tuiscrib:secret@ep-example.us-east-2.aws.neon.tech/tuiscrib?sslmode=require",
  })).toThrow("pooled")

  const environment = loadServiceEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://tuiscrib:secret@ep-example-pooler.us-east-2.aws.neon.tech/tuiscrib?sslmode=require",
    MIGRATION_DATABASE_URL: "postgresql://tuiscrib:secret@ep-example.us-east-2.aws.neon.tech/tuiscrib?sslmode=require",
  })

  expect(environment.requirePooledDatabaseUrl).toBe(true)
  expect(environment.databasePoolMax).toBe(4)
  expect(environment.migrationDatabaseUrl).not.toContain("-pooler")
})

test("requires a direct TLS endpoint for hosted migrations", () => {
  expect(() => loadServiceEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://tuiscrib:secret@ep-example-pooler.us-east-2.aws.neon.tech/tuiscrib?sslmode=require",
  })).toThrow("MIGRATION_DATABASE_URL")

  expect(() => loadServiceEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://tuiscrib:secret@ep-example-pooler.us-east-2.aws.neon.tech/tuiscrib?sslmode=require",
    MIGRATION_DATABASE_URL: "postgresql://tuiscrib:secret@ep-example-pooler.us-east-2.aws.neon.tech/tuiscrib?sslmode=require",
  })).toThrow("direct")
})

test("normalizes bounded runtime settings and migration mode", () => {
  const environment = loadServiceEnvironment({
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/tuiscrib",
    HOST: "127.0.0.1",
    PORT: "4317",
    DATABASE_POOL_MAX: "8",
    DATABASE_CONNECT_TIMEOUT_SECONDS: "12",
    DATABASE_IDLE_TIMEOUT_SECONDS: "30",
    MIGRATION_LOCK_TIMEOUT_MS: "5000",
    MIGRATION_LOCK_POLL_MS: "25",
    TUISCRIB_MIGRATIONS_PREDEPLOYED: "true",
    WEBSOCKET_IDLE_TIMEOUT_SECONDS: "90",
  })

  expect(environment).toMatchObject({
    host: "127.0.0.1",
    port: 4317,
    databasePoolMax: 8,
    databaseConnectTimeoutSeconds: 12,
    databaseIdleTimeoutSeconds: 30,
    migrationLockTimeoutMs: 5_000,
    migrationLockPollMs: 25,
    migrationsPredeployed: true,
    websocketIdleTimeoutSeconds: 90,
  })
})

test("redacts database URLs and bearer credentials from operational errors", () => {
  const message = redactServiceError(new Error(
    "connect failed for postgresql://user:secret@ep-test-pooler.example.test/db?sslmode=require with Bearer abcdef123456",
  ))

  expect(message).toContain("[redacted database URL]")
  expect(message).toContain("Bearer [redacted]")
  expect(message).not.toContain("secret")
  expect(message).not.toContain("abcdef123456")
})
