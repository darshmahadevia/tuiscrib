import { fileURLToPath } from "node:url"

import { redactServiceError } from "../packages/service/src/config.ts"

type ProcessResult = { stdout: string; stderr: string }

const repositoryDirectory = fileURLToPath(new URL("..", import.meta.url))
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12)
const imageName = `tuiscrib-smoke:${suffix}`
const networkName = `tuiscrib-smoke-${suffix}`
const databaseContainer = `tuiscrib-smoke-db-${suffix}`
const serviceContainer = `tuiscrib-smoke-service-${suffix}`
let networkCreated = false
let imageBuilt = false

async function main(): Promise<void> {
  await runProcess(["docker", "info"])
  await runProcess(["docker", "build", "--tag", imageName, "."])
  imageBuilt = true
  await runProcess(["docker", "network", "create", networkName])
  networkCreated = true

  await runProcess([
    "docker", "run", "--detach", "--name", databaseContainer,
    "--network", networkName,
    "--env", "POSTGRES_USER=postgres",
    "--env", "POSTGRES_PASSWORD=tuiscrib-test",
    "--env", "POSTGRES_DB=tuiscrib_test",
    "postgres:16-alpine",
  ])
  await waitForDatabase()

  const databaseUrl = `postgresql://postgres:tuiscrib-test@${databaseContainer}:5432/tuiscrib_test`
  await runProcess([
    "docker", "run", "--detach", "--name", serviceContainer,
    "--network", networkName,
    "--publish", "127.0.0.1::3000",
    "--env", `DATABASE_URL=${databaseUrl}`,
    "--env", `MIGRATION_DATABASE_URL=${databaseUrl}`,
    "--env", "NODE_ENV=development",
    "--env", "HOST=0.0.0.0",
    "--env", "PORT=3000",
    "--env", "DATABASE_POOL_MAX=4",
    "--env", "TUISCRIB_MIGRATIONS_PREDEPLOYED=false",
    imageName,
  ])
  const port = await waitForPublishedPort()
  const baseUrl = `http://127.0.0.1:${port}`
  await waitForHealth(baseUrl)
  await runProcess(["bun", "scripts/hosted-smoke.ts", "--url", baseUrl], { cwd: repositoryDirectory })
  console.log("Container smoke passed: image start, startup migration-before-traffic, health, WebSocket, and Postgres durability.")
}

async function waitForDatabase(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await runProcess(["docker", "exec", databaseContainer, "pg_isready", "-U", "postgres", "-d", "tuiscrib_test"])
      return
    } catch {
      await Bun.sleep(250)
    }
  }
  throw new Error("The disposable PostgreSQL container did not become ready.")
}

async function waitForPublishedPort(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const result = await runProcess(["docker", "port", serviceContainer, "3000/tcp"])
      const match = result.stdout.match(/:(\d+)\s*$/m)
      if (match) {
        return match[1]
      }
    } catch {
      // The service container may still be starting.
    }
    await Bun.sleep(250)
  }
  throw new Error("The Tuiscrib Service container did not publish a port.")
}

async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health?probe=readiness`)
      if (response.ok) {
        return
      }
    } catch {
      // The service may still be applying migrations or opening its pool.
    }
    await Bun.sleep(250)
  }
  throw new Error("The Tuiscrib Service container did not become ready.")
}

async function runProcess(
  argv: string[],
  options: { cwd?: string } = {},
): Promise<ProcessResult> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd ?? repositoryDirectory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdoutPromise = child.stdout ? new Response(child.stdout).text() : Promise.resolve("")
  const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("")
  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`${argv[0]} exited with ${exitCode}: ${redact(stderr || stdout)}`)
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

function redact(value: string): string {
  return redactServiceError(value)
}

async function cleanup(): Promise<void> {
  await runProcess(["docker", "rm", "--force", serviceContainer]).catch(() => undefined)
  await runProcess(["docker", "rm", "--force", databaseContainer]).catch(() => undefined)
  if (networkCreated) {
    await runProcess(["docker", "network", "rm", networkName]).catch(() => undefined)
  }
  if (imageBuilt) {
    await runProcess(["docker", "image", "rm", imageName]).catch(() => undefined)
  }
}

try {
  await main()
} catch (error) {
  console.error(`Container smoke failed: ${redact(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
} finally {
  await cleanup()
}
