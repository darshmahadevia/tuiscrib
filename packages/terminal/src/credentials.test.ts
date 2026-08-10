import { afterEach, expect, test } from "bun:test"
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createCredentialStore,
  getTerminalSessionCredentialPath,
  type CredentialStore,
} from "./credentials.ts"

const temporaryDirectories: string[] = []
const credential = "a".repeat(43)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test("uses the protected platform config location for a Terminal Session", () => {
  expect(
    getTerminalSessionCredentialPath({ platform: "darwin", homeDirectory: "/Users/alice" }),
  ).toBe("/Users/alice/Library/Application Support/Tuiscrib/session")
  expect(
    getTerminalSessionCredentialPath({
      platform: "linux",
      homeDirectory: "/home/alice",
      env: {},
    }),
  ).toBe("/home/alice/.config/tuiscrib/session")
  expect(
    getTerminalSessionCredentialPath({
      platform: "linux",
      homeDirectory: "/home/alice",
      env: { XDG_CONFIG_HOME: "/srv/config" },
    }),
  ).toBe("/srv/config/tuiscrib/session")
  expect(
    getTerminalSessionCredentialPath({
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
    }),
  ).toBe("C:\\Users\\alice\\AppData\\Roaming\\Tuiscrib\\session")
})

test("persists one Terminal Session credential with owner-only permissions and removes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuiscrib-credential-"))
  temporaryDirectories.push(directory)
  const store = createCredentialStore({ platform: "linux", configDirectory: directory })

  expect(await store.load()).toBeNull()
  await chmod(directory, 0o755)
  await store.save(credential)
  await chmod(store.filePath, 0o644)
  await store.save(credential)

  expect(await store.load()).toBe(credential)
  expect(await readFile(store.filePath, "utf8")).toBe(credential)
  expect(await readdir(directory)).toEqual(["session"])

  const directoryMode = (await stat(directory)).mode & 0o777
  const fileMode = (await stat(store.filePath)).mode & 0o777
  expect(directoryMode).toBe(0o700)
  expect(fileMode).toBe(0o600)

  await store.remove()
  expect(await store.load()).toBeNull()
  expect(await readdir(directory)).toEqual([])
})

test("rejects a malformed local credential without exposing its contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuiscrib-credential-"))
  temporaryDirectories.push(directory)
  const store: CredentialStore = createCredentialStore({
    platform: "linux",
    configDirectory: directory,
  })
  await store.save(credential)
  await writeFile(store.filePath, "not-a-session", { mode: 0o600 })

  let failure: unknown
  try {
    await store.load()
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({ code: "malformed" })
  expect(String(failure)).not.toContain("not-a-session")

  await store.remove()
  expect(await store.load()).toBeNull()
})

test("fails closed when the configured credential directory is a symlink", async () => {
  if (process.platform === "win32") {
    return
  }

  const parent = await mkdtemp(join(tmpdir(), "tuiscrib-credential-"))
  const target = await mkdtemp(join(tmpdir(), "tuiscrib-credential-target-"))
  temporaryDirectories.push(parent, target)
  const linkedDirectory = join(parent, "config")
  await symlink(target, linkedDirectory, "dir")
  const store = createCredentialStore({ platform: "linux", configDirectory: linkedDirectory })

  await expect(store.save(credential)).rejects.toMatchObject({ code: "insecure" })
  expect(await readdir(target)).toEqual([])
})
