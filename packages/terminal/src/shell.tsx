import { flushSync, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { InputRenderable, TerminalCapabilities } from "@opentui/core"
import { useEffect, useRef, useState, type ReactNode } from "react"

export const MIN_TERMINAL_WIDTH = 80
export const MIN_TERMINAL_HEIGHT = 24

export type ShellMode = "navigate" | "edit"

export type TerminalShellProps = {
  label?: string
  capabilities?: TerminalCapabilities | null
}

type ShellOverlay = "none" | "help"
type ShellView = "home" | "boards" | "board-actions" | "canvas" | "form" | "confirmation"

type FormKind = "sign-in" | "register" | "create-board" | "join-board"

type FormField = {
  id: string
  label: string
  placeholder: string
}

type FormDefinition = {
  title: string
  description: string
  fields: FormField[]
}

type ShellNotice = {
  kind: "status" | "error"
  message: string
}

type ShellMenuItem = {
  key: string
  label: string
  description: string
}

const homeMenu: ShellMenuItem[] = [
  { key: "b", label: "boards", description: "Open the Board list" },
  { key: "s", label: "sign in", description: "Sign in as a User" },
  { key: "r", label: "register", description: "Register a new User" },
]

const boardMenu: ShellMenuItem[] = [
  { key: "o", label: "open Board", description: "Open the collaboration canvas" },
  { key: "c", label: "create Board", description: "Start a new Board" },
  { key: "j", label: "join Board", description: "Redeem a Join Code" },
  { key: "a", label: "Board actions", description: "Manage the selected Board" },
]

const boardActionsMenu: ShellMenuItem[] = [
  { key: "d", label: "delete Board", description: "Permanently remove this Board" },
  { key: "l", label: "leave Board", description: "Leave this Board as a Member" },
]

const formDefinitions: Record<FormKind, FormDefinition> = {
  "sign-in": {
    title: "Sign in",
    description: "Enter your immutable User identity to continue.",
    fields: [
      { id: "username", label: "Username", placeholder: "lowercase username" },
      { id: "password", label: "Password", placeholder: "password" },
    ],
  },
  register: {
    title: "Register User",
    description: "Choose a service-wide username and a confirmed password.",
    fields: [
      { id: "username", label: "Username", placeholder: "lowercase username" },
      { id: "password", label: "Password", placeholder: "8-128 Unicode characters" },
      { id: "confirmation", label: "Confirm password", placeholder: "repeat password" },
    ],
  },
  "create-board": {
    title: "Create Board",
    description: "Give the new Board a human-readable name.",
    fields: [{ id: "name", label: "Board name", placeholder: "name" }],
  },
  "join-board": {
    title: "Join Board",
    description: "Redeem the current Join Code to become a Member.",
    fields: [{ id: "joinCode", label: "Join Code", placeholder: "grouped code" }],
  },
}

const colors = {
  background: "#0d1117",
  panel: "#161b22",
  panelStrong: "#21262d",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#8b949e",
  accent: "#58a6ff",
  success: "#3fb950",
  warning: "#d29922",
  error: "#f85149",
}

export function TerminalShell({ label = "local", capabilities: capabilitiesOverride }: TerminalShellProps) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [detectedCapabilities, setDetectedCapabilities] = useState(renderer.capabilities)
  const [overlay, setOverlay] = useState<ShellOverlay>("none")
  const [view, setView] = useState<ShellView>("home")
  const [mode, setMode] = useState<ShellMode>("navigate")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [formKind, setFormKind] = useState<FormKind | null>(null)
  const [formReturnView, setFormReturnView] = useState<ShellView>("home")
  const [formInitialKey, setFormInitialKey] = useState<string | null>(null)
  const [confirmationReturnView, setConfirmationReturnView] = useState<ShellView>("boards")
  const [notice, setNotice] = useState<ShellNotice | null>(null)
  const overlayRef = useRef(overlay)
  const viewRef = useRef(view)
  const modeRef = useRef(mode)
  const selectedIndexRef = useRef(selectedIndex)
  overlayRef.current = overlay
  viewRef.current = view
  modeRef.current = mode
  selectedIndexRef.current = selectedIndex

  useEffect(() => {
    if (capabilitiesOverride) {
      return
    }

    const handleCapabilities = (nextCapabilities: TerminalCapabilities) => {
      setDetectedCapabilities(nextCapabilities)
    }
    renderer.on("capabilities", handleCapabilities)
    if (renderer.capabilities) {
      setDetectedCapabilities(renderer.capabilities)
    }
    return () => {
      renderer.off("capabilities", handleCapabilities)
    }
  }, [capabilitiesOverride, renderer])

  const moveSelection = (direction: -1 | 1) => {
    const items =
      viewRef.current === "home"
        ? homeMenu
        : viewRef.current === "boards"
          ? boardMenu
          : boardActionsMenu
    const nextIndex = Math.max(
      0,
      Math.min(items.length - 1, selectedIndexRef.current + direction),
    )
    flushSync(() => setSelectedIndex(nextIndex))
  }

  const openView = (nextView: ShellView) => {
    flushSync(() => {
      setView(nextView)
      setMode("navigate")
      setSelectedIndex(0)
      if (nextView !== "form") {
        setFormKind(null)
      }
      setFormInitialKey(null)
      setNotice(null)
    })
  }

  const openForm = (
    nextFormKind: FormKind,
    returnView: ShellView = viewRef.current,
    initialKey: string | null = null,
  ) => {
    flushSync(() => {
      setView("form")
      setFormKind(nextFormKind)
      setFormReturnView(returnView)
      setFormInitialKey(initialKey)
      setSelectedIndex(0)
      setNotice(null)
    })
  }

  const openConfirmation = (returnView: ShellView) => {
    flushSync(() => {
      setView("confirmation")
      setConfirmationReturnView(returnView)
      setSelectedIndex(0)
      setNotice(null)
    })
  }

  const resolveConfirmation = (confirmed: boolean) => {
    flushSync(() => {
      setView(confirmationReturnView)
      setSelectedIndex(0)
      setNotice({
        kind: "status",
        message: confirmed ? "Board action confirmed." : "Action cancelled.",
      })
    })
  }

  const completeForm = (values: Record<string, string>) => {
    if (!formKind) {
      return
    }

    const definition = formDefinitions[formKind]
    const missingField = definition.fields.find((field) => !values[field.id]?.trim())
    if (missingField) {
      flushSync(() => {
        setNotice({ kind: "error", message: `${missingField.label} is required.` })
      })
      return
    }

    if (formKind === "register" && values.password !== values.confirmation) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Passwords do not match." })
      })
      return
    }

    const completedLabel = formKind === "register" ? "registration" : definition.title.toLowerCase()
    flushSync(() => {
      setView(formReturnView)
      setFormKind(null)
      setFormInitialKey(null)
      setSelectedIndex(0)
      setNotice({ kind: "status", message: `${completedLabel} form complete` })
    })
  }

  useKeyboard((key) => {
    if (overlayRef.current === "help") {
      if (key.name === "escape" || key.name === "?") {
        flushSync(() => setOverlay("none"))
      }
      return
    }

    if (viewRef.current === "home") {
      if (key.name === "up" || key.name === "k") {
        moveSelection(-1)
        return
      }
      if (key.name === "down" || key.name === "j") {
        moveSelection(1)
        return
      }
      if (key.name === "b") {
        openView("boards")
        return
      }
      if (key.name === "s") {
        openForm("sign-in", "home", key.name)
        return
      }
      if (key.name === "r") {
        openForm("register", "home", key.name)
        return
      }
      if (key.name === "return" && selectedIndexRef.current === 0) {
        openView("boards")
        return
      }
      if (key.name === "return" && selectedIndexRef.current === 1) {
        openForm("sign-in")
        return
      }
      if (key.name === "return" && selectedIndexRef.current === 2) {
        openForm("register")
        return
      }
    }

    if (viewRef.current === "boards") {
      if (key.name === "escape") {
        openView("home")
        return
      }
      if (key.name === "up" || key.name === "k") {
        moveSelection(-1)
        return
      }
      if (key.name === "down" || key.name === "j") {
        moveSelection(1)
        return
      }
      if (key.name === "c") {
        openForm("create-board", "boards", key.name)
        return
      }
      if (key.name === "j") {
        openForm("join-board", "boards", key.name)
        return
      }
      if (key.name === "a") {
        openView("board-actions")
        return
      }
      if (key.name === "o") {
        openView("canvas")
        return
      }
      if (key.name === "return" && selectedIndexRef.current === 1) {
        openForm("create-board", "boards")
        return
      }
      if (key.name === "return" && selectedIndexRef.current === 2) {
        openForm("join-board", "boards")
        return
      }
      if (key.name === "return" && selectedIndexRef.current === 3) {
        openView("board-actions")
        return
      }
      if (key.name === "return" && selectedIndexRef.current === 0) {
        openView("canvas")
        return
      }
    }

    if (viewRef.current === "canvas") {
      if (modeRef.current === "navigate" && key.name === "return") {
        flushSync(() => setMode("edit"))
        return
      }
      if (modeRef.current === "edit" && key.name === "escape") {
        flushSync(() => setMode("navigate"))
        return
      }
      if (modeRef.current === "navigate" && key.name === "escape") {
        openView("boards")
        return
      }
      if (key.name === "?") {
        flushSync(() => setOverlay("help"))
        return
      }
      if (key.name === "q") {
        renderer.destroy()
        return
      }
      return
    }

    if (viewRef.current === "board-actions") {
      if (key.name === "escape") {
        openView("boards")
        return
      }
      if (key.name === "up" || key.name === "k") {
        moveSelection(-1)
        return
      }
      if (key.name === "down" || key.name === "j") {
        moveSelection(1)
        return
      }
      if (key.name === "d" || (key.name === "return" && selectedIndexRef.current === 0)) {
        openConfirmation("board-actions")
        return
      }
      if (key.name === "l" || (key.name === "return" && selectedIndexRef.current === 1)) {
        openConfirmation("board-actions")
        return
      }
    }

    if (viewRef.current === "confirmation") {
      if (key.name === "y") {
        resolveConfirmation(true)
        return
      }
      if (key.name === "n" || key.name === "escape") {
        resolveConfirmation(false)
        return
      }
      return
    }

    if (viewRef.current === "form") {
      return
    }

    if (key.name === "?") {
      flushSync(() => setOverlay("help"))
      return
    }

    if (key.name === "q") {
      renderer.destroy()
    }
  })

  if (width < MIN_TERMINAL_WIDTH || height < MIN_TERMINAL_HEIGHT) {
    return <ResizeRequiredScreen width={width} height={height} />
  }

  const content = overlay === "help" ? (
    <HelpOverlay />
  ) : view === "home" ? (
    <ShellHome
      selectedIndex={selectedIndex}
      status={notice?.kind === "status" ? notice.message : "shell ready"}
    />
  ) : view === "board-actions" ? (
    <BoardActions
      selectedIndex={selectedIndex}
      status={notice?.kind === "status" ? notice.message : "choose an action"}
    />
  ) : view === "confirmation" ? (
    <ShellConfirmation />
  ) : view === "canvas" ? (
    <CanvasSurface mode={mode} />
  ) : view === "form" && formKind ? (
    <ShellForm
      key={formKind}
      definition={formDefinitions[formKind]}
      notice={notice}
      initialKeyToIgnore={formInitialKey}
      onCancel={() => openView(formReturnView)}
      onSubmit={completeForm}
    />
  ) : (
    <BoardList selectedIndex={selectedIndex} />
  )
  const footerHint =
    overlay === "help"
      ? "Escape close"
      : view === "form"
        ? "Tab fields · Enter submit · Escape cancel"
        : view === "confirmation"
          ? "y confirm · n cancel · Escape cancel"
          : view === "canvas"
            ? mode === "edit"
              ? "? help · q quit · Escape leave Edit mode"
              : "? help · q quit · Escape back"
            : "? help · q quit"

  return (
    <ShellFrame
      label={label}
      mode={mode}
      capabilities={capabilitiesOverride ?? detectedCapabilities}
      footerHint={footerHint}
    >
      {content}
    </ShellFrame>
  )
}

function ShellFrame({
  label,
  mode,
  capabilities,
  footerHint,
  children,
}: {
  label: string
  mode: ShellMode
  capabilities: TerminalCapabilities | null
  footerHint: string
  children: ReactNode
}) {
  const modeLabel = mode === "navigate" ? "NAVIGATE" : "EDIT"
  const modeColor = mode === "navigate" ? colors.accent : colors.warning
  const capabilityLabel = capabilities?.rgb
    ? "Unicode · 256-color baseline · truecolor detected"
    : "Unicode · 256-color baseline"

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: colors.background,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <box
        style={{
          width: "100%",
          height: 3,
          border: true,
          borderStyle: "rounded",
          borderColor: colors.border,
          paddingX: 1,
          flexDirection: "row",
          gap: 2,
        }}
      >
        <text fg={colors.accent}>TUISCRIB · SHELL</text>
        <text fg={modeColor}>MODE  {modeLabel}</text>
      </box>

      <box style={{ flexGrow: 1, width: "100%", paddingY: 1 }}>{children}</box>

      <box
        style={{
          width: "100%",
          height: 4,
          border: true,
          borderStyle: "rounded",
          borderColor: colors.border,
          paddingX: 1,
          flexDirection: "column",
        }}
      >
        <text fg={colors.muted}>{capabilityLabel}</text>
        <text fg={colors.muted}>User: {label} · {footerHint}</text>
      </box>
    </box>
  )
}

function ShellHome({ selectedIndex, status }: { selectedIndex: number; status: string }) {
  return (
    <ShellMenu
      title="Welcome to Tuiscrib"
      description="Choose a workflow. Every action remains keyboard reachable."
      items={homeMenu}
      selectedIndex={selectedIndex}
      status={status}
      canGoBack={false}
    />
  )
}

function BoardList({ selectedIndex }: { selectedIndex: number }) {
  return (
    <ShellMenu
      title="Board list"
      description="Memberships will appear here when the Board workflow is connected."
      items={boardMenu}
      selectedIndex={selectedIndex}
      status="choose a Board action"
    />
  )
}

function BoardActions({ selectedIndex, status }: { selectedIndex: number; status: string }) {
  return (
    <ShellMenu
      title="Board actions"
      description="Governance actions stay behind explicit keyboard confirmation."
      items={boardActionsMenu}
      selectedIndex={selectedIndex}
      status={status}
    />
  )
}

function ShellConfirmation() {
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <box
        style={{
          width: 64,
          border: true,
          borderStyle: "rounded",
          borderColor: colors.warning,
          backgroundColor: colors.panel,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.warning}>Confirm Board action</text>
        <text fg={colors.text}>This action changes shared Board state.</text>
        <text fg={colors.muted}>Review the action before continuing.</text>
        <text fg={colors.warning}>y confirm · n cancel · Escape cancel</text>
      </box>
    </box>
  )
}

function CanvasSurface({ mode }: { mode: ShellMode }) {
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <box
        style={{
          width: 64,
          border: true,
          borderStyle: "rounded",
          borderColor: mode === "navigate" ? colors.accent : colors.warning,
          backgroundColor: colors.panel,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.text}>Board canvas</text>
        {mode === "navigate" ? (
          <>
            <text fg={colors.accent}>Navigate mode · cursor at the stable origin</text>
            <text fg={colors.muted}>Enter edit · arrows / hjkl move the canvas cursor</text>
          </>
        ) : (
          <>
            <text fg={colors.warning}>Edit mode · keyboard text editing active</text>
            <text fg={colors.muted}>Escape leave Edit mode · input stays local to this shell</text>
          </>
        )}
      </box>
    </box>
  )
}

function ShellForm({
  definition,
  notice,
  initialKeyToIgnore,
  onCancel,
  onSubmit,
}: {
  definition: FormDefinition
  notice: ShellNotice | null
  initialKeyToIgnore: string | null
  onCancel: () => void
  onSubmit: (values: Record<string, string>) => void
}) {
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  const focusedIndexRef = useRef(focusedIndex)
  const valuesRef = useRef(values)
  const inputRefs = useRef<Array<InputRenderable | null>>([])
  const initialKeyToIgnoreRef = useRef(initialKeyToIgnore)
  focusedIndexRef.current = focusedIndex
  valuesRef.current = values

  useEffect(() => {
    inputRefs.current[focusedIndex]?.focus()
  }, [focusedIndex])

  const focusField = (index: number) => {
    const nextIndex = (index + definition.fields.length) % definition.fields.length
    focusedIndexRef.current = nextIndex
    flushSync(() => setFocusedIndex(nextIndex))
  }

  useKeyboard((key) => {
    if (key.name === "tab") {
      focusField(focusedIndexRef.current + 1)
      return
    }
    if (key.name === "escape") {
      onCancel()
    }
  })

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <box
        style={{
          width: 64,
          border: true,
          borderStyle: "rounded",
          borderColor: colors.border,
          backgroundColor: colors.panel,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.accent}>{definition.title}</text>
        <text fg={colors.muted}>{definition.description}</text>
        {definition.fields.map((field, index) => (
          <box key={field.id} style={{ width: "100%", flexDirection: "row" }}>
            <text fg={colors.muted} style={{ width: 20 }}>
              {focusedIndex === index ? "› " : "  "}{field.label}:
            </text>
            <input
              ref={(input) => {
                inputRefs.current[index] = input
              }}
              focused={focusedIndex === index}
              width={36}
              placeholder={field.placeholder}
              backgroundColor={colors.panelStrong}
              focusedBackgroundColor="#26374d"
              textColor={colors.text}
              cursorColor={colors.accent}
              onInput={(value) => {
                if (initialKeyToIgnoreRef.current && value === initialKeyToIgnoreRef.current) {
                  const input = inputRefs.current[index]
                  if (input) {
                    input.value = ""
                  }
                  initialKeyToIgnoreRef.current = null
                  return
                }
                const nextValues = { ...valuesRef.current, [field.id]: value }
                valuesRef.current = nextValues
                setValues(nextValues)
              }}
              onSubmit={() => onSubmit(valuesRef.current)}
            />
          </box>
        ))}
        {notice?.kind === "error" ? <text fg={colors.error}>Error: {notice.message}</text> : null}
        <text fg={colors.muted}>Tab next field · Enter submit · Escape cancel</text>
      </box>
    </box>
  )
}

function ShellMenu({
  title,
  description,
  items,
  selectedIndex,
  status,
  canGoBack = true,
}: {
  title: string
  description: string
  items: ShellMenuItem[]
  selectedIndex: number
  status: string
  canGoBack?: boolean
}) {
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <box
        style={{
          width: 58,
          border: true,
          borderStyle: "rounded",
          borderColor: colors.border,
          backgroundColor: colors.panel,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.text}>{title}</text>
        <text fg={colors.muted}>{description}</text>
        {items.map((item, index) => (
          <text key={item.key} fg={index === selectedIndex ? colors.accent : colors.text}>
            {index === selectedIndex ? "›" : " "} {item.key} {item.label}
          </text>
        ))}
        <text fg={colors.muted}>
          {canGoBack ? "↑↓ / jk move · Enter choose · Escape back" : "↑↓ / jk move · Enter choose"}
        </text>
        <text fg={colors.success}>Status: {status}</text>
      </box>
    </box>
  )
}

function HelpOverlay() {
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <box
        style={{
          width: 64,
          border: true,
          borderStyle: "rounded",
          borderColor: colors.accent,
          backgroundColor: colors.panel,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.accent}>Keyboard help</text>
        <text fg={colors.text}>Navigate mode · move through menus and the Board.</text>
        <text fg={colors.text}>Edit mode     · type into the selected Sticky Note.</text>
        <text fg={colors.muted}>b boards · s sign in · r register</text>
        <text fg={colors.muted}>Boards: o open · c create · j join · a actions</text>
        <text fg={colors.muted}>Forms: Tab next field · Enter submit · Escape cancel</text>
        <text fg={colors.muted}>Confirmations: y confirm · n cancel</text>
        <text fg={colors.muted}>↑↓ / jk move · Enter choose · Escape back</text>
        <text fg={colors.muted}>q quit · ? toggle help</text>
        <text fg={colors.success}>Escape close</text>
      </box>
    </box>
  )
}

function ResizeRequiredScreen({ width, height }: { width: number; height: number }) {
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: colors.background,
        alignItems: "center",
        justifyContent: "center",
        padding: 1,
      }}
    >
      <box
        style={{
          width: "100%",
          border: true,
          borderStyle: "rounded",
          borderColor: colors.warning,
          backgroundColor: colors.panel,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.warning}>Resize required</text>
        <text fg={colors.text}>
          Tuiscrib needs at least {MIN_TERMINAL_WIDTH} by {MIN_TERMINAL_HEIGHT} cells.
        </text>
        <text fg={colors.muted}>Current terminal: {width} by {height}</text>
        <text fg={colors.muted}>Resize the terminal, then continue.</text>
      </box>
    </box>
  )
}
