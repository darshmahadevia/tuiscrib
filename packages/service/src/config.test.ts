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

test("requires a hosted pooled PostgreSQL endpoint for runtime configuration", () => {
  expect(() => loadServiceEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require",
  })).toThrow("pooled")

  const environment = loadServiceEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://postgres:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
    MIGRATION_DATABASE_URL: "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require",
  })

  expect(environment.requirePooledDatabaseUrl).toBe(true)
  expect(environment.databasePoolMax).toBe(4)
  expect(environment.migrationDatabaseUrl).toContain("db.example.supabase.co")
})

test("requires stable session semantics for hosted migrations", () => {
  expect(() => loadServiceEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://postgres:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
  })).toThrow("MIGRATION_DATABASE_URL")

  expect(() => loadServiceEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://postgres:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
    MIGRATION_DATABASE_URL: "postgresql://postgres:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
  })).toThrow("transaction pooling")

  const sessionPooledEnvironment = loadServiceEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://postgres:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
    MIGRATION_DATABASE_URL: "postgresql://postgres:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require",
  })
  expect(sessionPooledEnvironment.migrationDatabaseUrl).toContain(":5432/")
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
    "connect failed for postgresql://user:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require with Bearer abcdef123456",
  ))

  expect(message).toContain("[redacted database URL]")
  expect(message).toContain("Bearer [redacted]")
  expect(message).not.toContain("secret")
  expect(message).not.toContain("abcdef123456")
})
