import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  RELEASE_TARGETS,
  getCurrentReleaseTarget,
  getReleaseTarget,
  type ReleaseTarget,
} from "./release.ts"

const RELEASE_SOURCE_DIRECTORY = resolve(fileURLToPath(new URL(".", import.meta.url)))

export const RELEASE_ENTRYPOINT = resolve(RELEASE_SOURCE_DIRECTORY, "main.tsx")
export const RELEASE_REPOSITORY_ROOT = resolve(RELEASE_SOURCE_DIRECTORY, "../../..")
export const DEFAULT_RELEASE_OUTPUT_DIRECTORY = resolve(RELEASE_SOURCE_DIRECTORY, "../../../dist/releases")

export type ReleaseBuildArguments = {
  targetIds: ["current"] | ["all"] | [string]
  outputDirectory?: string
  verifyReproducible: boolean
}

export type BuiltReleaseArtifact = {
  target: ReleaseTarget
  path: string
  checksumPath: string
  bytes: number
  sha256: string
}

export function createReleaseBuildConfig(
  target: ReleaseTarget,
  outputPath: string,
): Bun.BuildConfig {
  return {
    entrypoints: [RELEASE_ENTRYPOINT],
    compile: {
      target: target.bunTarget,
      outfile: outputPath,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    minify: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      ...(target.libc ? { "process.env.OPENTUI_LIBC": JSON.stringify(target.libc) } : {}),
    },
  }
}

export function parseReleaseBuildArguments(arguments_: readonly string[]): ReleaseBuildArguments {
  let targetIds: ReleaseBuildArguments["targetIds"] = ["current"]
  let outputDirectory: string | undefined
  let verifyReproducible = false

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--all") {
      if (targetIds[0] !== "current" || arguments_.some((value) => value === "--target")) {
        throw new Error("--all cannot be combined with --target")
      }
      targetIds = ["all"]
      continue
    }
    if (argument === "--target") {
      const id = arguments_[index + 1]
      if (!id || id.startsWith("--")) {
        throw new Error("--target requires a release target id")
      }
      if (targetIds[0] === "all") {
        throw new Error("--all cannot be combined with --target")
      }
      targetIds = [id]
      index += 1
      continue
    }
    if (argument === "--output") {
      const directory = arguments_[index + 1]
      if (!directory || directory.startsWith("--")) {
        throw new Error("--output requires a directory")
      }
      outputDirectory = directory
      index += 1
      continue
    }
    if (argument === "--verify-reproducible") {
      verifyReproducible = true
      continue
    }
    if (argument === "--help" || argument === "-h") {
      continue
    }
    throw new Error(`Unknown release build argument: ${argument}`)
  }

  return { targetIds, outputDirectory, verifyReproducible }
}

export function resolveReleaseTargets(
  targetIds: ReleaseBuildArguments["targetIds"],
): readonly ReleaseTarget[] {
  if (targetIds[0] === "current") {
    return [getCurrentReleaseTarget()]
  }
  if (targetIds[0] === "all") {
    return RELEASE_TARGETS
  }
  return [getReleaseTarget(targetIds[0])]
}

export async function buildReleaseArtifact(
  target: ReleaseTarget,
  outputDirectory: string = DEFAULT_RELEASE_OUTPUT_DIRECTORY,
): Promise<BuiltReleaseArtifact> {
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, target.artifactFile)
  const result = await Bun.build(createReleaseBuildConfig(target, outputPath))
  if (!result.success) {
    throw new Error(formatBuildFailure(target, result.logs))
  }

  const contents = await readFile(outputPath)
  const sha256 = createHash("sha256").update(contents).digest("hex")
  const checksumPath = `${outputPath}.sha256`
  await writeFile(checksumPath, `${sha256}  ${target.artifactFile}\n`, "utf8")
  return {
    target,
    path: outputPath,
    checksumPath,
    bytes: contents.byteLength,
    sha256,
  }
}

export async function verifyReproducibleBuild(target: ReleaseTarget): Promise<{
  target: ReleaseTarget
  sha256: string
  bytes: number
}> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tuiscrib-release-repro-"))
  try {
    const firstDirectory = join(temporaryRoot, "first")
    const secondDirectory = join(temporaryRoot, "second")
    await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)])

    const first = await buildReleaseArtifact(target, firstDirectory)
    const second = await buildReleaseArtifact(target, secondDirectory)
    if (first.sha256 !== second.sha256 || first.bytes !== second.bytes) {
      throw new Error(
        `Standalone build is not reproducible for ${target.id}: ` +
        `${first.sha256}/${first.bytes} differs from ${second.sha256}/${second.bytes}`,
      )
    }
    return { target, sha256: first.sha256, bytes: first.bytes }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function buildRelease(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<readonly BuiltReleaseArtifact[]> {
  const parsed = parseReleaseBuildArguments(arguments_)
  const outputDirectory = resolveReleasePath(
    parsed.outputDirectory ?? DEFAULT_RELEASE_OUTPUT_DIRECTORY,
  )
  const targets = resolveReleaseTargets(parsed.targetIds)
  const artifacts: BuiltReleaseArtifact[] = []

  for (const target of targets) {
    if (parsed.verifyReproducible) {
      const verified = await verifyReproducibleBuild(target)
      console.log(`${target.id}: reproducible sha256=${verified.sha256} bytes=${verified.bytes}`)
    }
    const artifact = await buildReleaseArtifact(target, outputDirectory)
    artifacts.push(artifact)
    console.log(`${target.id}: ${artifact.path} sha256=${artifact.sha256} bytes=${artifact.bytes}`)
  }

  return artifacts
}

export function resolveReleasePath(path: string): string {
  return resolve(RELEASE_REPOSITORY_ROOT, path)
}

function formatBuildFailure(target: ReleaseTarget, logs: readonly { message: string }[]): string {
  const details = logs.map((log) => log.message).join("\n")
  return `Standalone build failed for ${target.id}${details ? `:\n${details}` : "."}`
}

function printHelp(): void {
  console.log(`Build standalone Tuiscrib terminal binaries.

Usage: bun src/release-build.ts [--target <id> | --all] [--output <directory>] [--verify-reproducible]

Targets: ${RELEASE_TARGETS.map((target) => target.id).join(", ")}
`)
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2)
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    printHelp()
  } else {
    await buildRelease(arguments_)
  }
}
