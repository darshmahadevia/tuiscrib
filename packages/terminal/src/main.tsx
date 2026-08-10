import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

import { createAuthClient, createBoardClient } from "./client.ts"
import { TerminalShell } from "./shell.tsx"

const renderer = await createCliRenderer({ exitOnCtrlC: true })

createRoot(renderer).render(
  <TerminalShell
    label={process.env.TUISCRIB_CLIENT ?? "local"}
    authClient={createAuthClient(process.env.TUISCRIB_URL ?? "http://127.0.0.1:3000")}
    boardClient={createBoardClient(process.env.TUISCRIB_URL ?? "http://127.0.0.1:3000")}
  />,
)
