const DEFAULT_PORT = 3_000
const DEFAULT_HOST = "0.0.0.0"
const DEFAULT_DATABASE_POOL_MAX = 4
const DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS = 10
const DEFAULT_DATABASE_IDLE_TIMEOUT_SECONDS = 20
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 30_000
const DEFAULT_MIGRATION_LOCK_POLL_MS = 100
const DEFAULT_WEBSOCKET_IDLE_TIMEOUT_SECONDS = 120

export const MIN_DATABASE_POOL_MAX = 2
export const MAX_DATABASE_POOL_MAX = 8

export type ServiceEnvironment = {
  databaseUrl: string
  migrationDatabaseUrl: string
  host: string
  port: number
  databasePoolMax: number
  databaseConnectTimeoutSeconds: number
  databaseIdleTimeoutSeconds: number
  migrationLockTimeoutMs: number
  migrationLockPollMs: number
  migrationsPredeployed: boolean
  requirePooledDatabaseUrl: boolean
  websocketIdleTimeoutSeconds: number
}

export class ServiceEnvironmentError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Invalid Tuiscrib Service environment: ${issues.join(" ")}`)
    this.name = "ServiceEnvironmentError"
    this.issues = issues
  }
}

export function loadServiceEnvironment(
  environment: Record<string, string | undefined> = process.env,
): ServiceEnvironment {
  const issues: string[] = []
  const databaseUrl = environment.DATABASE_URL?.trim() ?? ""
  const configuredMigrationDatabaseUrl = environment.MIGRATION_DATABASE_URL?.trim() ?? ""
  const nodeEnvironment = environment.NODE_ENV?.trim().toLowerCase() ?? ""
  const explicitlyRequiresPooled = parseBoolean(
    "TUISCRIB_REQUIRE_POOLED_DATABASE_URL",
    environment.TUISCRIB_REQUIRE_POOLED_DATABASE_URL,
    issues,
  )
  const requirePooledDatabaseUrl = explicitlyRequiresPooled ?? nodeEnvironment === "production"

  if (databaseUrl.length === 0) {
    issues.push("DATABASE_URL is required.")
  } else {
    validateDatabaseUrl(databaseUrl, requirePooledDatabaseUrl, issues)
  }

  const migrationDatabaseUrl = configuredMigrationDatabaseUrl || databaseUrl
  if (
    migrationDatabaseUrl.length === 0 ||
    (requirePooledDatabaseUrl && configuredMigrationDatabaseUrl.length === 0)
  ) {
    issues.push("MIGRATION_DATABASE_URL is required for hosted migrations.")
  } else {
    validateMigrationDatabaseUrl(
      migrationDatabaseUrl,
      nodeEnvironment === "production",
      issues,
    )
  }

  const host = environment.HOST?.trim() || DEFAULT_HOST
  if (host.length === 0) {
    issues.push("HOST must not be empty.")
  }

  const port = parseInteger("PORT", environment.PORT, DEFAULT_PORT, 1, 65_535, issues)
  const databasePoolMax = parseInteger(
    "DATABASE_POOL_MAX",
    environment.DATABASE_POOL_MAX,
    DEFAULT_DATABASE_POOL_MAX,
    MIN_DATABASE_POOL_MAX,
    MAX_DATABASE_POOL_MAX,
    issues,
  )
  const databaseConnectTimeoutSeconds = parseInteger(
    "DATABASE_CONNECT_TIMEOUT_SECONDS",
    environment.DATABASE_CONNECT_TIMEOUT_SECONDS,
    DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS,
    1,
    60,
    issues,
  )
  const databaseIdleTimeoutSeconds = parseInteger(
    "DATABASE_IDLE_TIMEOUT_SECONDS",
    environment.DATABASE_IDLE_TIMEOUT_SECONDS,
    DEFAULT_DATABASE_IDLE_TIMEOUT_SECONDS,
    0,
    300,
    issues,
  )
  const migrationLockTimeoutMs = parseInteger(
    "MIGRATION_LOCK_TIMEOUT_MS",
    environment.MIGRATION_LOCK_TIMEOUT_MS,
    DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    100,
    120_000,
    issues,
  )
  const migrationLockPollMs = parseInteger(
    "MIGRATION_LOCK_POLL_MS",
    environment.MIGRATION_LOCK_POLL_MS,
    DEFAULT_MIGRATION_LOCK_POLL_MS,
    5,
    1_000,
    issues,
  )
  const websocketIdleTimeoutSeconds = parseInteger(
    "WEBSOCKET_IDLE_TIMEOUT_SECONDS",
    environment.WEBSOCKET_IDLE_TIMEOUT_SECONDS,
    DEFAULT_WEBSOCKET_IDLE_TIMEOUT_SECONDS,
    30,
    255,
    issues,
  )
  const migrationsPredeployed = parseBoolean(
    "TUISCRIB_MIGRATIONS_PREDEPLOYED",
    environment.TUISCRIB_MIGRATIONS_PREDEPLOYED,
    issues,
  ) ?? false

  if (nodeEnvironment === "production" && explicitlyRequiresPooled === false) {
    issues.push("TUISCRIB_REQUIRE_POOLED_DATABASE_URL cannot be false in production.")
  }

  if (issues.length > 0) {
    throw new ServiceEnvironmentError(issues)
  }

  return {
    databaseUrl,
    migrationDatabaseUrl,
    host,
    port,
    databasePoolMax,
    databaseConnectTimeoutSeconds,
    databaseIdleTimeoutSeconds,
    migrationLockTimeoutMs,
    migrationLockPollMs,
    migrationsPredeployed,
    requirePooledDatabaseUrl,
    websocketIdleTimeoutSeconds,
  }
}

export function redactServiceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[redacted database URL]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/\b(DATABASE_URL|MIGRATION_DATABASE_URL|PASSWORD|JOIN_CODE|SESSION_CREDENTIAL)\s*[=:]\s*[^\s]+/gi, "$1=[redacted]")
    .slice(0, 500)
}

function validateDatabaseUrl(
  databaseUrl: string,
  requirePooledDatabaseUrl: boolean,
  issues: string[],
): void {
  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch {
    issues.push("DATABASE_URL must be a valid PostgreSQL connection URL.")
    return
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    issues.push("DATABASE_URL must use the postgres or postgresql scheme.")
  }
  if (!parsed.hostname || !parsed.username || !parsed.password) {
    issues.push("DATABASE_URL must include a host, username, and password.")
  }

  if (requirePooledDatabaseUrl && !/-pooler(?:\.|$)/i.test(parsed.hostname)) {
    issues.push("DATABASE_URL must use Neon's pooled endpoint (the hostname contains -pooler).")
  }
  if (requirePooledDatabaseUrl && parsed.searchParams.get("sslmode")?.toLowerCase() !== "require") {
    issues.push("DATABASE_URL must require TLS with sslmode=require for hosted PostgreSQL.")
  }
}

function validateMigrationDatabaseUrl(
  databaseUrl: string,
  requireTls: boolean,
  issues: string[],
): void {
  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch {
    issues.push("MIGRATION_DATABASE_URL must be a valid PostgreSQL connection URL.")
    return
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    issues.push("MIGRATION_DATABASE_URL must use the postgres or postgresql scheme.")
  }
  if (!parsed.hostname || !parsed.username || !parsed.password) {
    issues.push("MIGRATION_DATABASE_URL must include a host, username, and password.")
  }
  if (/-pooler(?:\.|$)/i.test(parsed.hostname)) {
    issues.push("MIGRATION_DATABASE_URL must use Neon's direct (non-pooled) endpoint for migrations.")
  }
  if (requireTls && parsed.searchParams.get("sslmode")?.toLowerCase() !== "require") {
    issues.push("MIGRATION_DATABASE_URL must require TLS with sslmode=require for hosted PostgreSQL.")
  }
}

function parseInteger(
  name: string,
  rawValue: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  issues: string[],
): number {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return fallback
  }

  if (!/^\d+$/.test(rawValue.trim())) {
    issues.push(`${name} must be an integer from ${minimum} to ${maximum}.`)
    return fallback
  }

  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push(`${name} must be an integer from ${minimum} to ${maximum}.`)
    return fallback
  }
  return value
}

function parseBoolean(
  name: string,
  rawValue: string | undefined,
  issues: string[],
): boolean | undefined {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return undefined
  }
  const normalized = rawValue.trim().toLowerCase()
  if (normalized === "true") {
    return true
  }
  if (normalized === "false") {
    return false
  }
  issues.push(`${name} must be true or false.`)
  return undefined
}
