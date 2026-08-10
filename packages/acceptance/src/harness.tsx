import { ManualClock, type TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import postgres from "postgres"
import { act } from "react"

import { createPersistence, type Persistence } from "@tuiscrib/persistence"
import {
  createBoardCollaboration,
  createServiceApp,
  type BoardWebSocketData,
} from "@tuiscrib/service"
import {
  HealthScreen,
  type StickyNoteTimer,
  TerminalShell,
  type BoardClient,
  type CredentialStore,
} from "@tuiscrib/terminal"
import {
  createAuthClient,
  createBoardClient,
  createHealthClient,
} from "@tuiscrib/terminal/client"

type ProcessResult = {
  stdout: string
  stderr: string
}

async function runProcess(argv: string[]): Promise<ProcessResult> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const stdoutPromise = child.stdout ? new Response(child.stdout).text() : Promise.resolve("")
  const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("")
  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    child.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`${argv[0]} exited with ${exitCode}: ${stderr.trim()}`)
  }

  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

type DisposablePostgres = {
  databaseUrl: string
  stop(): Promise<void>
}

async function waitForDatabase(databaseUrl: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const client = postgres(databaseUrl, { max: 1, connect_timeout: 1 })
    try {
      await client`select 1`
      await client.end({ timeout: 2 })
      return
    } catch (error) {
      lastError = error
      await client.end({ timeout: 2 }).catch(() => undefined)
      await Bun.sleep(250)
    }
  }

  throw new Error(`PostgreSQL did not become ready: ${String(lastError)}`)
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const configuredUrl = process.env.TEST_DATABASE_URL
  if (configuredUrl) {
    await waitForDatabase(configuredUrl)
    return { databaseUrl: configuredUrl, stop: async () => undefined }
  }

  const containerName = `tuiscrib-acceptance-${crypto.randomUUID()}`
  const image = process.env.TEST_POSTGRES_IMAGE ?? "postgres:16-alpine"
  let containerId: string | undefined

  try {
    const started = await runProcess([
      "docker",
      "run",
      "--rm",
      "--detach",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_PASSWORD=tuiscrib-test",
      "--env",
      "POSTGRES_DB=tuiscrib_test",
      image,
    ])
    containerId = started.stdout

    let port: string | undefined
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const published = await runProcess(["docker", "port", containerId, "5432/tcp"])
        const match = published.stdout.match(/:(\d+)\s*$/m)
        if (match) {
          port = match[1]
          break
        }
      } catch {
        // The container may still be starting and have no published port yet.
      }
      await Bun.sleep(250)
    }

    if (!port) {
      throw new Error("PostgreSQL container did not publish a port")
    }

    const databaseUrl = `postgresql://postgres:tuiscrib-test@127.0.0.1:${port}/tuiscrib_test`
    await waitForDatabase(databaseUrl)

    return {
      databaseUrl,
      stop: async () => {
        if (containerId) {
          await runProcess(["docker", "stop", containerId])
        }
      },
    }
  } catch (error) {
    if (containerId) {
      await runProcess(["docker", "rm", "--force", containerId]).catch(() => undefined)
    }
    throw error
  }
}

export type TerminalClient = {
  label: string
  setup: TestRendererSetup
  credentialStore?: CredentialStore
}

export function createMemoryCredentialStore(
  initialCredential: string | null = null,
  filePath = "memory://tuiscrib/session",
): CredentialStore {
  let credential = initialCredential
  return {
    filePath,
    load: async () => credential,
    save: async (nextCredential) => {
      credential = nextCredential
    },
    remove: async () => {
      credential = null
    },
  }
}

export class AcceptanceHarness {
  readonly clients: TerminalClient[] = []

  private constructor(
    readonly clock: ManualClock,
    private readonly persistence: Persistence,
    private readonly database: DisposablePostgres,
  ) {
    this.server = this.createServer()
  }

  private server: Bun.Server<BoardWebSocketData>

  static async start(): Promise<AcceptanceHarness> {
    const database = await startDisposablePostgres()
    const persistence = createPersistence({ databaseUrl: database.databaseUrl })

    try {
      await persistence.migrate()
      const clock = new ManualClock()
      clock.setTime(Date.parse("2026-08-10T00:00:00.000Z"))
      return new AcceptanceHarness(clock, persistence, database)
    } catch (error) {
      await persistence.close().catch(() => undefined)
      await database.stop().catch(() => undefined)
      throw error
    }
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  async restartService(): Promise<void> {
    await this.server.stop(true)
    this.server = this.createServer()
  }

  async addClient(label: string): Promise<TerminalClient> {
    enableActEnvironment()
    const setup = await testRender(
      <HealthScreen client={createHealthClient(this.baseUrl)} label={label} />,
      {
        width: 80,
        height: 24,
        clock: this.clock,
      },
    )
    await act(async () => {
      await setup.renderOnce()
    })
    const client = { label, setup }
    this.clients.push(client)
    return client
  }

  async addShellClient(
    label: string,
    credentialStore: CredentialStore = createMemoryCredentialStore(),
    boardClient: BoardClient = createBoardClient(this.baseUrl),
    stickyNoteTimer?: StickyNoteTimer,
  ): Promise<TerminalClient> {
    enableActEnvironment()
    let setup!: TestRendererSetup
    await act(async () => {
      setup = await testRender(
        <TerminalShell
          label={label}
          authClient={createAuthClient(this.baseUrl)}
          boardClient={boardClient}
          credentialStore={credentialStore}
          stickyNoteTimer={stickyNoteTimer}
        />,
        {
          width: 80,
          height: 24,
          clock: this.clock,
          kittyKeyboard: true,
        },
      )
      await setup.renderOnce()
    })
    const client = { label, setup, credentialStore }
    this.clients.push(client)
    return client
  }

  async disposeClient(client: TerminalClient): Promise<void> {
    const index = this.clients.indexOf(client)
    if (index >= 0) {
      this.clients.splice(index, 1)
    }

    enableActEnvironment()
    await act(async () => {
      client.setup.renderer.destroy()
    })
    enableActEnvironment()
  }

  async dispose(): Promise<void> {
    let cleanupError: unknown

    for (const client of [...this.clients]) {
      try {
        await this.disposeClient(client)
      } catch (error) {
        cleanupError ??= error
      }
    }

    try {
      await this.server.stop(true)
    } catch (error) {
      cleanupError ??= error
    }

    try {
      await this.persistence.reset()
    } catch (error) {
      cleanupError ??= error
    }

    try {
      await this.persistence.close()
    } catch (error) {
      cleanupError ??= error
    }

    try {
      await this.database.stop()
    } catch (error) {
      cleanupError ??= error
    }

    if (cleanupError) {
      throw cleanupError
    }
  }

  private createServer(): Bun.Server<BoardWebSocketData> {
    const collaboration = createBoardCollaboration({
      persistence: this.persistence,
      clock: () => new Date(this.clock.now()),
    })
    const app = createServiceApp({
      persistence: this.persistence,
      collaboration,
      clock: () => new Date(this.clock.now()),
      authRateLimit: { maxAttempts: 100 },
      boardRateLimit: { maxAttempts: 1_000 },
    })
    return Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, bunServer) {
        const result = await collaboration.handleUpgrade(request, bunServer)
        if (result !== null) {
          return result
        }
        return app.fetch(request)
      },
      websocket: collaboration.websocket,
    })
  }
}

function enableActEnvironment(): void {
  ;(globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }).IS_REACT_ACT_ENVIRONMENT = true
}
