import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

import { HealthScreen } from "./app.tsx"
import { createHealthClient } from "./client.ts"

const renderer = await createCliRenderer({ exitOnCtrlC: true })
const baseUrl = process.env.TUISCRIB_URL ?? "http://127.0.0.1:3000"

createRoot(renderer).render(
  <HealthScreen client={createHealthClient(baseUrl)} label={process.env.TUISCRIB_CLIENT ?? "local"} />,
)
