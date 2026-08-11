export const DEFAULT_TUISCRIB_SERVER_URL = "https://tuiscrib.onrender.com"

type ServerEnvironment = Readonly<{ TUISCRIB_URL?: string }>

export function parseServerArgument(arguments_: readonly string[]): string | undefined {
  let serverUrl: string | undefined

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    const inlineValue = argument.startsWith("--server=")
      ? argument.slice("--server=".length)
      : undefined

    if (argument !== "--server" && inlineValue === undefined) {
      throw new Error(`Unknown terminal argument: ${argument}. Use --server <url>.`)
    }
    if (serverUrl !== undefined) {
      throw new Error("--server may only be provided once")
    }

    if (inlineValue !== undefined) {
      if (inlineValue.length === 0) {
        throw new Error("--server requires a URL")
      }
      serverUrl = inlineValue
      continue
    }

    const value = arguments_[index + 1]
    if (!value || value.startsWith("--")) {
      throw new Error("--server requires a URL")
    }
    serverUrl = value
    index += 1
  }

  return serverUrl
}

export function resolveServerUrl(
  arguments_: readonly string[] = [],
  environment: ServerEnvironment = { TUISCRIB_URL: process.env.TUISCRIB_URL },
): string {
  const argumentValue = parseServerArgument(arguments_)
  if (argumentValue !== undefined) {
    return validateServerUrl(argumentValue, "--server")
  }

  const environmentValue = environment.TUISCRIB_URL?.trim()
  if (environmentValue) {
    return validateServerUrl(environmentValue, "TUISCRIB_URL")
  }

  return DEFAULT_TUISCRIB_SERVER_URL
}

export function validateServerUrl(value: string, source = "server URL"): string {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw invalidServerUrl(source)
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw invalidServerUrl(source)
  }

  return parsed.origin
}

function invalidServerUrl(source: string): Error {
  return new Error(
    `${source} must be an http(s) server origin such as ${DEFAULT_TUISCRIB_SERVER_URL}`,
  )
}
