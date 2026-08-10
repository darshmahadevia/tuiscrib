import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { spawn as spawnPty } from "node-pty"

import {
  getCurrentReleaseTarget,
  getReleaseTarget,
  type ReleaseTarget,
} from "./release.ts"
import {
  DEFAULT_RELEASE_OUTPUT_DIRECTORY,
  resolveReleasePath,
} from "./release-build.ts"

export const TERMINAL_FIRST_RENDER_MARKERS = [
  "TUISCRIB",
  "MODE  NAVIGATE",
  "Unicode",
  "256-color baseline",
  "q quit",
] as const

export type TerminalSmokeOutput = {
  stdout: string
  stderr: string
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  transport: "pipe" | "conpty"
}

export type TerminalSmokeOptions = {
  binaryPath: string
  timeoutMs?: number
  environment?: NodeJS.ProcessEnv
}

export async function runTerminalSmokeTest(
  options: TerminalSmokeOptions,
): Promise<TerminalSmokeOutput> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const smokeDirectory = await mkdtemp(join(tmpdir(), "tuiscrib-terminal-smoke-"))
  const emptyPath = join(smokeDirectory, "empty-path")
  await mkdir(emptyPath)

  try {
    const environment = createSmokeEnvironment(smokeDirectory, emptyPath, options.environment)
    const result = process.platform === "win32"
      ? await runConptySmoke(options.binaryPath, environment, timeoutMs)
      : await runPipedSmoke([resolve(options.binaryPath)], environment, timeoutMs)
    assertTerminalFirstRender(result)
    return result
  } finally {
    await rm(smokeDirectory, { recursive: true, force: true })
  }
}

async function runPipedSmoke(
  command: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<TerminalSmokeOutput> {
  const child = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: environment,
  })
  let timedOut = false
  let sentQuit = false
  let stdout = ""
  let stderr = ""

  try {
    const stdoutReader = readStream(child.stdout, (chunk) => {
      stdout += chunk
      if (!sentQuit && hasTerminalFirstRender(stdout)) {
        sentQuit = true
        child.stdin.write("q")
        child.stdin.end()
      }
    })
    const stderrReader = readStream(child.stderr, (chunk) => {
      stderr += chunk
    })
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    const exitCode = await child.exited
    clearTimeout(timeout)
    await Promise.all([stdoutReader, stderrReader])
    if (timedOut) {
      throw new Error(
        `standalone binary did not complete within ${timeoutMs}ms` +
        ` (captured ${stdout.length} bytes of stdout)`,
      )
    }
    return {
      stdout,
      stderr,
      exitCode,
      signalCode: child.signalCode,
      transport: "pipe",
    }
  } finally {
    if (!child.killed) {
      child.kill()
    }
  }
}

async function runConptySmoke(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<TerminalSmokeOutput> {
  const child = spawnPty(resolve(binaryPath), [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    env: toPtyEnvironment(environment),
    useConpty: true,
  })
  const ignorePtyError = (): void => {}
  const eventEmitter = child as unknown as {
    on: (event: "error", listener: typeof ignorePtyError) => void
  }
  eventEmitter.on("error", ignorePtyError)
  eventEmitter.on("error", ignorePtyError)

  return new Promise((resolveResult, reject) => {
    let output = ""
    let sentQuit = false
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill()
      reject(new Error(
        `standalone binary did not complete within ${timeoutMs}ms` +
        ` (captured ${output.length} bytes of conpty output)`,
      ))
    }, timeoutMs)

    child.onData((chunk) => {
      output += chunk
      if (!sentQuit && hasTerminalFirstRender(output)) {
        sentQuit = true
        child.write("q")
      }
    })
    child.onExit(({ exitCode }) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolveResult({
        stdout: output,
        stderr: "",
        exitCode,
        signalCode: null,
        transport: "conpty",
      })
    })
  })
}

function toPtyEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

function createSmokeEnvironment(
  smokeDirectory: string,
  emptyPath: string,
  overrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "",
    TUISCRIB_CLIENT: "platform-smoke",
    TUISCRIB_URL: "http://127.0.0.1:9",
    HOME: join(smokeDirectory, "home"),
    USERPROFILE: join(smokeDirectory, "home"),
    XDG_CONFIG_HOME: join(smokeDirectory, "xdg-config"),
    APPDATA: join(smokeDirectory, "appdata", "roaming"),
    PATH: emptyPath,
    ...overrides,
  }
}

export function assertTerminalFirstRender(output: TerminalSmokeOutput): void {
  if (output.exitCode !== 0) {
    throw new Error(
      `standalone binary exited with code ${output.exitCode ?? "unknown"}` +
      (output.stderr ? `: ${output.stderr.trim()}` : ""),
    )
  }
  if (!hasTerminalFirstRender(output.stdout)) {
    throw new Error(
      "first render did not contain the keyboard-only shell, Unicode, and 256-color baseline",
    )
  }
  if (!output.stdout.includes("\u001b[") || !output.stdout.includes(";5;")) {
    throw new Error("first render did not contain ANSI 256-color output")
  }
}

export type ReleaseSmokeArguments = {
  binaryPath: string
  timeoutMs?: number
}

export function parseReleaseSmokeArguments(
  arguments_: readonly string[],
): ReleaseSmokeArguments {
  let target: ReleaseTarget = getCurrentReleaseTarget()
  let binaryPath: string | undefined
  let timeoutMs: number | undefined

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--binary") {
      const value = arguments_[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error("--binary requires an executable path")
      }
      binaryPath = value
      index += 1
      continue
    }
    if (argument === "--target") {
      const value = arguments_[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error("--target requires a release target id")
      }
      target = getReleaseTarget(value)
      index += 1
      continue
    }
    if (argument === "--timeout-ms") {
      const value = arguments_[index + 1]
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--timeout-ms requires a positive number")
      }
      timeoutMs = parsed
      index += 1
      continue
    }
    if (argument === "--help" || argument === "-h") {
      continue
    }
    throw new Error(`Unknown release smoke argument: ${argument}`)
  }

  return {
    binaryPath: resolveReleasePath(
      binaryPath ?? join(DEFAULT_RELEASE_OUTPUT_DIRECTORY, target.artifactFile),
    ),
    timeoutMs,
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        const finalChunk = decoder.decode()
        if (finalChunk) {
          onChunk(finalChunk)
        }
        return
      }
      onChunk(decoder.decode(next.value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
}

function hasTerminalFirstRender(output: string): boolean {
  return TERMINAL_FIRST_RENDER_MARKERS.every((marker) => output.includes(marker))
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2)
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    console.log("Usage: bun src/release-smoke.ts [--target <id> | --binary <path>] [--timeout-ms <ms>]")
  } else {
    const options = parseReleaseSmokeArguments(arguments_)
    const result = await runTerminalSmokeTest(options)
    console.log(`first render verified via ${result.transport}; clean exit ${result.exitCode}`)
  }
}
