import { useKeyboard, useRenderer } from "@opentui/react"
import { useCallback, useEffect, useState } from "react"

import type { HealthResponse } from "@tuiscrib/contracts"

import type { HealthClient } from "./client.ts"

export type HealthScreenProps = {
  client: HealthClient
  label: string
}

type HealthState =
  | { status: "checking"; health?: undefined; error?: undefined }
  | { status: "ready"; health: HealthResponse; error?: undefined }
  | { status: "unavailable"; health?: undefined; error: string }

export function HealthScreen({ client, label }: HealthScreenProps) {
  const renderer = useRenderer()
  const [state, setState] = useState<HealthState>({ status: "checking" })

  const refresh = useCallback(() => {
    setState({ status: "checking" })
    void client
      .checkHealth()
      .then((health) => setState({ status: "ready", health }))
      .catch((error: unknown) => {
        setState({
          status: "unavailable",
          error: error instanceof Error ? error.message : "service unavailable",
        })
      })
  }, [client])

  useEffect(() => {
    refresh()
  }, [refresh])

  useKeyboard((key) => {
    if (key.name === "r") {
      refresh()
    }
    if (key.name === "q") {
      renderer.destroy()
    }
  })

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <text fg="#7dd3fc">TUISCRIB</text>
      <text>Walking skeleton</text>
      <text>Terminal client: {label}</text>
      <text>
        Service: {state.status === "ready" ? state.health.service : state.status}
      </text>
      <text>
        Database: {state.status === "ready" ? state.health.database : state.status}
      </text>
      <text>
        Checked at: {state.status === "ready" ? state.health.checkedAt : "—"}
      </text>
      {state.status === "unavailable" ? <text fg="#f87171">Error: {state.error}</text> : null}
      <text>r refresh · q quit</text>
    </box>
  )
}
