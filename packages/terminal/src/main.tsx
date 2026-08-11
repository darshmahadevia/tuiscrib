import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

import { createAuthClient, createBoardClient } from "./client.ts"
import { resolveServerUrl } from "./server.ts"
import { TerminalShell } from "./shell.tsx"

const serverUrl = resolveServerUrl(process.argv.slice(2))
const renderer = await createCliRenderer({ exitOnCtrlC: true })

createRoot(renderer).render(
  <TerminalShell
    label={process.env.TUISCRIB_CLIENT ?? "local"}
    authClient={createAuthClient(serverUrl)}
    boardClient={createBoardClient(serverUrl)}
  />,
)
