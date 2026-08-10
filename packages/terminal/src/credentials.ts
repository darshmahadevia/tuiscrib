import { randomBytes } from "node:crypto"
import * as fileSystem from "node:fs/promises"
import type { Stats } from "node:fs"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"

import { terminalSessionCredentialSchema } from "@tuiscrib/contracts"

const CREDENTIAL_FILE_NAME = "session"

export type CredentialFileSystem = Pick<
  typeof fileSystem,
  "chmod" | "lstat" | "mkdir" | "open" | "readFile" | "rename" | "unlink"
>

export type CredentialStoreOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  configDirectory?: string
  fileSystem?: CredentialFileSystem
}

export type CredentialStore = {
  readonly filePath: string
  load(): Promise<string | null>
  save(credential: string): Promise<void>
  remove(): Promise<void>
}

export type CredentialStoreErrorCode = "malformed" | "insecure" | "unavailable"

export class CredentialStoreError extends Error {
  constructor(readonly code: CredentialStoreErrorCode) {
    super(credentialStoreErrorMessage(code))
    this.name = "CredentialStoreError"
  }
}

export type CredentialPathOptions = Pick<
  CredentialStoreOptions,
  "platform" | "env" | "homeDirectory" | "configDirectory"
>

export function getTerminalSessionCredentialPath(options: CredentialPathOptions = {}): string {
  const platform = options.platform ?? process.platform
  const environment = options.env ?? process.env
  const homeDirectory = options.homeDirectory ?? homedir()
  const pathModule = platform === "win32" ? win32 : posix
  const configDirectory =
    options.configDirectory ?? platformConfigDirectory(
      platform,
      environment,
      homeDirectory,
      pathModule,
    )

  return pathModule.join(configDirectory, CREDENTIAL_FILE_NAME)
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const platform = options.platform ?? process.platform
  const pathModule = platform === "win32" ? win32 : posix
  const filePath = getTerminalSessionCredentialPath(options)
  const configDirectory = pathModule.dirname(filePath)
  const fs = options.fileSystem ?? fileSystem

  return {
    filePath,

    async load() {
      const directory = await readExistingDirectory(fs, configDirectory)
      if (!directory) {
        return null
      }
      if (directory.isSymbolicLink() || !directory.isDirectory()) {
        throw new CredentialStoreError("insecure")
      }
      assertProtected(directory, platform, "insecure")

      const existing = await readExistingPath(fs, filePath)
      if (!existing) {
        return null
      }
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new CredentialStoreError("insecure")
      }
      assertProtected(existing, platform, "insecure")

      let credential: string
      try {
        credential = await fs.readFile(filePath, "utf8")
      } catch {
        throw new CredentialStoreError("unavailable")
      }

      if (!terminalSessionCredentialSchema.safeParse(credential).success) {
        throw new CredentialStoreError("malformed")
      }
      return credential
    },

    async save(credential) {
      if (!terminalSessionCredentialSchema.safeParse(credential).success) {
        throw new CredentialStoreError("malformed")
      }

      try {
        await ensureProtectedDirectory(fs, configDirectory, platform)
        const existing = await readExistingPath(fs, filePath)
        if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
          throw new CredentialStoreError("insecure")
        }

        const temporaryPath = pathModule.join(
          configDirectory,
          `.${CREDENTIAL_FILE_NAME}.${randomBytes(16).toString("hex")}.tmp`,
        )
        let temporaryCreated = false
        try {
          const handle = await fs.open(temporaryPath, "wx", 0o600)
          temporaryCreated = true
          try {
            await handle.writeFile(credential, "utf8")
            await handle.sync()
          } finally {
            await handle.close()
          }
          await fs.chmod(temporaryPath, 0o600)
          await fs.rename(temporaryPath, filePath)
          await fs.chmod(filePath, 0o600)
        } catch (error) {
          if (temporaryCreated) {
            await fs.unlink(temporaryPath).catch(() => undefined)
          }
          if (error instanceof CredentialStoreError) {
            throw error
          }
          throw new CredentialStoreError("unavailable")
        }
      } catch (error) {
        if (error instanceof CredentialStoreError) {
          throw error
        }
        throw new CredentialStoreError("unavailable")
      }
    },

    async remove() {
      try {
        const directory = await readExistingDirectory(fs, configDirectory)
        if (!directory) {
          return
        }
        if (directory.isSymbolicLink() || !directory.isDirectory()) {
          throw new CredentialStoreError("insecure")
        }
        assertProtected(directory, platform, "insecure")

        const existing = await readExistingPath(fs, filePath)
        if (!existing) {
          return
        }
        if (!existing.isFile() && !existing.isSymbolicLink()) {
          throw new CredentialStoreError("insecure")
        }
        await fs.unlink(filePath)
      } catch (error) {
        if (error instanceof CredentialStoreError) {
          throw error
        }
        if (isMissing(error)) {
          return
        }
        throw new CredentialStoreError("unavailable")
      }
    },
  }
}

function platformConfigDirectory(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  pathModule: typeof posix | typeof win32,
): string {
  if (platform === "win32") {
    return pathModule.join(
      environment.APPDATA || pathModule.join(homeDirectory, "AppData", "Roaming"),
      "Tuiscrib",
    )
  }
  if (platform === "darwin") {
    return pathModule.join(homeDirectory, "Library", "Application Support", "Tuiscrib")
  }
  return pathModule.join(environment.XDG_CONFIG_HOME || pathModule.join(homeDirectory, ".config"), "tuiscrib")
}

async function ensureProtectedDirectory(
  fs: CredentialFileSystem,
  directory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const directoryStats = await fs.lstat(directory)
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new CredentialStoreError("insecure")
    }
    if (platform !== "win32") {
      await fs.chmod(directory, 0o700)
    }
  } catch (error) {
    if (error instanceof CredentialStoreError) {
      throw error
    }
    throw new CredentialStoreError("unavailable")
  }
}

async function readExistingDirectory(
  fs: CredentialFileSystem,
  directory: string,
): Promise<Stats | null> {
  try {
    return await fs.lstat(directory)
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw new CredentialStoreError("unavailable")
  }
}

async function readExistingPath(fs: CredentialFileSystem, path: string): Promise<Stats | null> {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw new CredentialStoreError("unavailable")
  }
}

function assertProtected(
  stats: Stats,
  platform: NodeJS.Platform,
  code: CredentialStoreErrorCode,
): void {
  if (platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new CredentialStoreError(code)
  }

  if (
    platform !== "win32" &&
    typeof process.getuid === "function" &&
    typeof stats.uid === "number" &&
    stats.uid !== process.getuid()
  ) {
    throw new CredentialStoreError(code)
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

function credentialStoreErrorMessage(code: CredentialStoreErrorCode): string {
  switch (code) {
    case "malformed":
      return "Stored Terminal Session credential is malformed."
    case "insecure":
      return "Stored Terminal Session credential is not protected."
    case "unavailable":
      return "Stored Terminal Session could not be accessed securely."
  }
}
