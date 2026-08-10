import { expect, test } from "bun:test"

import {
  RELEASE_TARGETS,
  getCurrentReleaseTarget,
  getReleaseTarget,
} from "./release.ts"
import {
  createReleaseBuildConfig,
  parseReleaseBuildArguments,
} from "./release-build.ts"
import {
  assertTerminalFirstRender,
  type TerminalSmokeOutput,
} from "./release-smoke.ts"

test("defines reproducible standalone targets for every supported platform architecture", () => {
  expect(RELEASE_TARGETS.map((target) => target.id)).toEqual([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
  ])

  expect(RELEASE_TARGETS.map((target) => [
    target.id,
    target.bunTarget,
    target.artifactFile,
    target.platform,
    target.architecture,
    ("libc" in target ? target.libc ?? null : null),
  ])).toEqual([
    ["darwin-arm64", "bun-darwin-arm64", "tuiscrib-darwin-arm64", "darwin", "arm64", null],
    ["darwin-x64", "bun-darwin-x64", "tuiscrib-darwin-x64", "darwin", "x64", null],
    ["linux-arm64", "bun-linux-arm64", "tuiscrib-linux-arm64", "linux", "arm64", "glibc"],
    ["linux-x64", "bun-linux-x64-baseline", "tuiscrib-linux-x64", "linux", "x64", "glibc"],
    ["win32-x64", "bun-windows-x64", "tuiscrib-windows-x64.exe", "win32", "x64", null],
  ])
})

test("resolves target ids and the host target without inventing a platform", () => {
  expect(getReleaseTarget("linux-x64")).toMatchObject({
    id: "linux-x64",
    platform: "linux",
    architecture: "x64",
  })
  expect(getCurrentReleaseTarget("darwin", "arm64").id).toBe("darwin-arm64")
  expect(getCurrentReleaseTarget("linux", "x64").id).toBe("linux-x64")
  expect(() => getCurrentReleaseTarget("win32", "arm64")).toThrow(
    "No standalone release target is defined for win32-arm64",
  )
  expect(() => getCurrentReleaseTarget("freebsd", "x64")).toThrow(
    "No standalone release target is defined for freebsd-x64",
  )
})

test("build configuration pins OpenTUI libc selection and disables development autoloading", () => {
  const target = getReleaseTarget("linux-x64")
  const config = createReleaseBuildConfig(target, "/tmp/release/tuiscrib-linux-x64")

  expect(config.entrypoints).toHaveLength(1)
  expect(config.entrypoints[0]).toMatch(/packages[\\/]terminal[\\/]src[\\/]main\.tsx$/)
  expect(config.compile).toMatchObject({
    target: "bun-linux-x64-baseline",
    outfile: "/tmp/release/tuiscrib-linux-x64",
    autoloadDotenv: false,
    autoloadBunfig: false,
  })
  expect(config.define).toMatchObject({
    "process.env.NODE_ENV": '"production"',
    "process.env.OPENTUI_LIBC": '"glibc"',
  })

  const macConfig = createReleaseBuildConfig(
    getReleaseTarget("darwin-arm64"),
    "/tmp/release/tuiscrib-darwin-arm64",
  )
  expect(macConfig.define).not.toHaveProperty("process.env.OPENTUI_LIBC")
})

test("parses one target, all targets, output directory, and reproducibility verification", () => {
  expect(parseReleaseBuildArguments([])).toEqual({
    targetIds: ["current"],
    outputDirectory: undefined,
    verifyReproducible: false,
  })
  expect(parseReleaseBuildArguments([
    "--target",
    "linux-x64",
    "--output",
    "dist/release",
    "--verify-reproducible",
  ])).toEqual({
    targetIds: ["linux-x64"],
    outputDirectory: "dist/release",
    verifyReproducible: true,
  })
  expect(parseReleaseBuildArguments(["--all"])).toEqual({
    targetIds: ["all"],
    outputDirectory: undefined,
    verifyReproducible: false,
  })
  expect(() => parseReleaseBuildArguments(["--target", "linux-x64", "--all"])).toThrow(
    "--all cannot be combined with --target",
  )
})

test("accepts a first render only when the shell, Unicode, and 256-color baseline are present", () => {
  const output: TerminalSmokeOutput = {
    stdout: "\u001b[38;5;75mTUISCRIB · SHELL\u001b[0m MODE  NAVIGATE Unicode · 256-color baseline q quit",
    stderr: "",
    exitCode: 0,
    signalCode: null,
    transport: "pipe",
  }

  expect(() => assertTerminalFirstRender(output)).not.toThrow()
  expect(() => assertTerminalFirstRender({ ...output, stdout: "TUISCRIB MODE NAVIGATE q quit" })).toThrow(
    "first render did not contain the keyboard-only shell, Unicode, and 256-color baseline",
  )
  expect(() => assertTerminalFirstRender({ ...output, exitCode: 1 })).toThrow(
    "standalone binary exited with code 1",
  )
})
