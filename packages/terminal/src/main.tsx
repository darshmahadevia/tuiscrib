import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

import { TerminalShell } from "./shell.tsx"

const renderer = await createCliRenderer({ exitOnCtrlC: true })

createRoot(renderer).render(
  <TerminalShell label={process.env.TUISCRIB_CLIENT ?? "local"} />,
)
