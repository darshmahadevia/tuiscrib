export type ReleasePlatform = "darwin" | "linux" | "win32"
export type ReleaseArchitecture = "arm64" | "x64"
export type ReleaseLibc = "glibc"

export type ReleaseTarget = {
  readonly id: `${ReleasePlatform}-${ReleaseArchitecture}`
  readonly platform: ReleasePlatform
  readonly architecture: ReleaseArchitecture
  readonly bunTarget:
    | "bun-darwin-arm64"
    | "bun-darwin-x64"
    | "bun-linux-arm64"
    | "bun-linux-x64-baseline"
    | "bun-windows-x64"
  readonly artifactFile: string
  readonly libc?: ReleaseLibc
}

export const RELEASE_TARGETS = [
  {
    id: "darwin-arm64",
    platform: "darwin",
    architecture: "arm64",
    bunTarget: "bun-darwin-arm64",
    artifactFile: "tuiscrib-darwin-arm64",
  },
  {
    id: "darwin-x64",
    platform: "darwin",
    architecture: "x64",
    bunTarget: "bun-darwin-x64",
    artifactFile: "tuiscrib-darwin-x64",
  },
  {
    id: "linux-arm64",
    platform: "linux",
    architecture: "arm64",
    bunTarget: "bun-linux-arm64",
    artifactFile: "tuiscrib-linux-arm64",
    libc: "glibc",
  },
  {
    id: "linux-x64",
    platform: "linux",
    architecture: "x64",
    bunTarget: "bun-linux-x64-baseline",
    artifactFile: "tuiscrib-linux-x64",
    libc: "glibc",
  },
  {
    id: "win32-x64",
    platform: "win32",
    architecture: "x64",
    bunTarget: "bun-windows-x64",
    artifactFile: "tuiscrib-windows-x64.exe",
  },
] as const satisfies readonly ReleaseTarget[]

export function getReleaseTarget(id: string): ReleaseTarget {
  const target = RELEASE_TARGETS.find((candidate) => candidate.id === id)
  if (!target) {
    throw new Error(`Unknown standalone release target: ${id}`)
  }
  return target
}

export function getCurrentReleaseTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ReleaseTarget {
  const target = RELEASE_TARGETS.find(
    (candidate) => candidate.platform === platform && candidate.architecture === architecture,
  )
  if (!target) {
    throw new Error(`No standalone release target is defined for ${platform}-${architecture}`)
  }
  return target
}
