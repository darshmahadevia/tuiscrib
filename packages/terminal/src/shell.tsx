import { flushSync, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { InputRenderable, TerminalCapabilities } from "@opentui/core"
import { useEffect, useRef, useState, type ReactNode } from "react"

import {
  countUserPerceivedCharacters,
  splitUserPerceivedCharacters,
} from "@tuiscrib/contracts"

import { ServiceRequestError, type AuthClient } from "./client.ts"
import {
  createCredentialStore,
  CredentialStoreError,
  type CredentialStore,
} from "./credentials.ts"

export const MIN_TERMINAL_WIDTH = 80
export const MIN_TERMINAL_HEIGHT = 24

export type ShellMode = "navigate" | "edit"

export type TerminalShellProps = {
  label?: string
  capabilities?: TerminalCapabilities | null
  authClient?: AuthClient
  credentialStore?: CredentialStore
}

type ShellOverlay = "none" | "help"
type ShellView = "home" | "boards" | "board-actions" | "canvas" | "form" | "confirmation"

type FormKind = "sign-in" | "register" | "create-board" | "join-board"

type FormField = {
  id: string
  label: string
  placeholder: string
  sensitive?: boolean
  maxLength?: number
}

type FormDefinition = {
  title: string
  description: string
  fields: FormField[]
  warning?: string
}

type ShellNotice = {
  kind: "status" | "error"
  message: string
}

type SessionState = "checking" | "signed-out" | "signed-in"

type ShellMenuItem = {
  key: string
  label: string
  description: string
}

const homeMenu: ShellMenuItem[] = [
  { key: "b", label: "boards", description: "Open the Board list" },
  { key: "s", label: "sign in", description: "Sign in as a User" },
  { key: "r", label: "register", description: "Register a new User" },
  { key: "x", label: "sign out", description: "Revoke the current Terminal Session" },
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
      { id: "password", label: "Password", placeholder: "password", sensitive: true },
    ],
  },
  register: {
    title: "Register User",
    description:
      "Username: 3-24 lowercase ASCII letters, digits, hyphens, or underscores. Password: 8-128 user-perceived Unicode characters; spaces allowed.",
    warning: "Password recovery is unavailable; losing this password permanently loses access.",
    fields: [
      { id: "username", label: "Username", placeholder: "lowercase username" },
      {
        id: "password",
        label: "Password",
        placeholder: "8-128 Unicode characters",
        sensitive: true,
      },
      {
        id: "confirmation",
        label: "Confirm password",
        placeholder: "repeat password",
        sensitive: true,
      },
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

export function TerminalShell({
  label = "local",
  capabilities: capabilitiesOverride,
  authClient,
  credentialStore: credentialStoreOverride,
}: TerminalShellProps) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [credentialStore] = useState<CredentialStore>(
    () => credentialStoreOverride ?? createCredentialStore(),
  )
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
  const [formPending, setFormPending] = useState(false)
  const [sessionState, setSessionState] = useState<SessionState>(
    authClient ? "checking" : "signed-out",
  )
  const [authenticatedUsername, setAuthenticatedUsername] = useState<string | null>(null)
  const [signOutPending, setSignOutPending] = useState(false)
  const overlayRef = useRef(overlay)
  const viewRef = useRef(view)
  const modeRef = useRef(mode)
  const selectedIndexRef = useRef(selectedIndex)
  const sessionStateRef = useRef(sessionState)
  const signOutPendingRef = useRef(signOutPending)
  overlayRef.current = overlay
  viewRef.current = view
  modeRef.current = mode
  selectedIndexRef.current = selectedIndex
  sessionStateRef.current = sessionState
  signOutPendingRef.current = signOutPending

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

  useEffect(() => {
    if (!authClient) {
      return
    }

    let active = true
    void (async () => {
      try {
        const credential = await credentialStore.load()
        if (!active) {
          return
        }
        if (!credential) {
          flushSync(() => {
            setSessionState("signed-out")
            setNotice({
              kind: "error",
              message: "No saved Terminal Session. Sign in to continue.",
            })
          })
          return
        }

        const response = await authClient.restore(credential)
        if (!active) {
          return
        }
        flushSync(() => {
          setAuthenticatedUsername(response.user.username)
          setSessionState("signed-in")
          setNotice({
            kind: "status",
            message: `Terminal Session restored for ${response.user.username}.`,
          })
        })
      } catch (error) {
        if (shouldDiscardCredential(error)) {
          await credentialStore.remove().catch(() => undefined)
        }
        if (!active) {
          return
        }
        flushSync(() => {
          setAuthenticatedUsername(null)
          setSessionState("signed-out")
          setNotice({ kind: "error", message: formatSessionError(error) })
        })
      }
    })()

    return () => {
      active = false
    }
  }, [authClient, credentialStore])

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
      setFormPending(false)
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
      setFormPending(false)
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

  const completeForm = async (values: Record<string, string>) => {
    if (!formKind || formPending) {
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

    if (authClient && (formKind === "register" || formKind === "sign-in")) {
      flushSync(() => setFormPending(true))
      try {
        const response =
          formKind === "register"
            ? await authClient.register({
                username: values.username,
                password: values.password,
                confirmation: values.confirmation,
              })
            : await authClient.signIn({
                username: values.username,
                password: values.password,
              })
        try {
          await credentialStore.save(response.sessionCredential)
        } catch (error) {
          await authClient.signOut(response.sessionCredential).catch(() => undefined)
          throw error
        }
        const completedLabel = formKind === "register" ? "Registration" : "Sign-in"
        flushSync(() => {
          setView(formReturnView)
          setFormKind(null)
          setFormInitialKey(null)
          setSelectedIndex(0)
          setAuthenticatedUsername(response.user.username)
          setSessionState("signed-in")
          setNotice({
            kind: "status",
            message: `${completedLabel} complete for ${response.user.username}. Terminal Session ready.`,
          })
        })
      } catch (error) {
        flushSync(() => {
          setNotice({ kind: "error", message: formatAuthError(error) })
        })
      } finally {
        flushSync(() => setFormPending(false))
      }
      return
    }

    const completedLabel = formKind === "register" ? "registration" : definition.title.toLowerCase()
    flushSync(() => {
      setView(formReturnView)
      setFormKind(null)
      setFormInitialKey(null)
      setSelectedIndex(0)
      setNotice({ kind: "status", message: `${completedLabel} form complete` })
      setFormPending(false)
    })
  }

  const signOut = async () => {
    if (signOutPendingRef.current) {
      return
    }

    if (!authClient) {
      flushSync(() => {
        setNotice({ kind: "status", message: "No active Terminal Session." })
      })
      return
    }

    flushSync(() => setSignOutPending(true))
    try {
      const credential = await credentialStore.load()
      if (credential) {
        await authClient.signOut(credential)
      }
      await credentialStore.remove()
      flushSync(() => {
        setAuthenticatedUsername(null)
        setSessionState("signed-out")
        setNotice({ kind: "status", message: "Signed out. Terminal Session revoked." })
      })
    } catch (error) {
      flushSync(() => {
        setNotice({ kind: "error", message: formatSessionError(error) })
      })
    } finally {
      flushSync(() => setSignOutPending(false))
    }
  }

  useKeyboard((key) => {
    if (sessionStateRef.current === "checking" || signOutPendingRef.current) {
      return
    }

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
      if (key.name === "x") {
        void signOut()
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
      if (key.name === "return" && selectedIndexRef.current === 3) {
        void signOut()
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
      sessionState={sessionState}
      notice={notice}
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
      pending={formPending}
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
            : "? help · x sign out · q quit"

  return (
    <ShellFrame
      label={authenticatedUsername ?? label}
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

function ShellHome({
  selectedIndex,
  sessionState,
  notice,
}: {
  selectedIndex: number
  sessionState: SessionState
  notice: ShellNotice | null
}) {
  return (
    <ShellMenu
      title="Welcome to Tuiscrib"
      description="Choose a workflow. Every action remains keyboard reachable."
      items={homeMenu}
      selectedIndex={selectedIndex}
      status={
        sessionState === "checking"
          ? "Restoring Terminal Session…"
          : notice?.kind === "status"
            ? notice.message
            : "shell ready"
      }
      error={notice?.kind === "error" ? notice.message : undefined}
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
  pending,
  initialKeyToIgnore,
  onCancel,
  onSubmit,
}: {
  definition: FormDefinition
  notice: ShellNotice | null
  pending: boolean
  initialKeyToIgnore: string | null
  onCancel: () => void
  onSubmit: (values: Record<string, string>) => void | Promise<void>
}) {
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  const focusedIndexRef = useRef(focusedIndex)
  const valuesRef = useRef(values)
  const inputRefs = useRef<Array<InputRenderable | null>>([])
  const initialKeyToIgnoreRef = useRef(initialKeyToIgnore)
  const secretValuesRef = useRef<Record<string, string>>({})
  const displayedSecretValuesRef = useRef<Record<string, string>>({})
  const maskingInputRef = useRef(false)
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
    if (pending) {
      return
    }
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
        {definition.warning ? <text fg={colors.warning}>{definition.warning}</text> : null}
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
              maxLength={field.maxLength}
              placeholder={field.placeholder}
              backgroundColor={colors.panelStrong}
              focusedBackgroundColor={field.sensitive ? colors.panelStrong : "#26374d"}
              textColor={field.sensitive ? colors.panelStrong : colors.text}
              focusedTextColor={field.sensitive ? colors.panelStrong : colors.text}
              cursorColor={colors.accent}
              showCursor={!field.sensitive}
              onInput={(value) => {
                if (field.sensitive) {
                  if (maskingInputRef.current) {
                    return
                  }

                  const previousRawValue = secretValuesRef.current[field.id] ?? ""
                  const previousDisplayedValue = displayedSecretValuesRef.current[field.id] ?? ""
                  const nextRawValue = updateMaskedInputValue(
                    previousRawValue,
                    previousDisplayedValue,
                    value,
                  )
                  const nextDisplayedValue = "•".repeat(
                    countUserPerceivedCharacters(nextRawValue),
                  )
                  secretValuesRef.current[field.id] = nextRawValue
                  displayedSecretValuesRef.current[field.id] = nextDisplayedValue
                  const inputRenderable = inputRefs.current[index]
                  if (inputRenderable && inputRenderable.value !== nextDisplayedValue) {
                    maskingInputRef.current = true
                    inputRenderable.value = nextDisplayedValue
                    maskingInputRef.current = false
                  }
                  const nextValues = { ...valuesRef.current, [field.id]: nextRawValue }
                  valuesRef.current = nextValues
                  setValues(nextValues)
                  return
                }

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
        {pending ? <text fg={colors.muted}>Contacting the Tuiscrib Service…</text> : null}
        {notice?.kind === "error" ? <text fg={colors.error}>Error: {notice.message}</text> : null}
        <text fg={colors.muted}>Tab next field · Enter submit · Escape cancel</text>
      </box>
    </box>
  )
}

function formatAuthError(error: unknown): string {
  if (error instanceof CredentialStoreError) {
    return formatCredentialStoreError(error)
  }
  if (!(error instanceof ServiceRequestError)) {
    return "Service unavailable. Try again later."
  }

  const fieldErrors = Object.values(error.details.fieldErrors ?? {})
  return fieldErrors.length > 0
    ? `${error.details.error} ${fieldErrors.join(" ")}`
    : error.details.error
}

function formatSessionError(error: unknown): string {
  if (error instanceof CredentialStoreError) {
    return formatCredentialStoreError(error)
  }
  if (error instanceof ServiceRequestError) {
    return error.details.error
  }
  return "Service unavailable. Try again later."
}

function formatCredentialStoreError(error: CredentialStoreError): string {
  switch (error.code) {
    case "malformed":
      return "The saved Terminal Session is malformed. Sign in again."
    case "insecure":
      return "The saved Terminal Session is not protected. Sign in again."
    case "unavailable":
      return "The saved Terminal Session could not be read securely. Try again later."
  }
}

function shouldDiscardCredential(error: unknown): boolean {
  return (
    (error instanceof ServiceRequestError && error.status === 401) ||
    (error instanceof CredentialStoreError &&
      (error.code === "malformed" || error.code === "insecure"))
  )
}

function updateMaskedInputValue(
  previousRawValue: string,
  previousDisplayedValue: string,
  nextDisplayedValue: string,
): string {
  let prefixLength = 0
  while (
    prefixLength < previousDisplayedValue.length &&
    prefixLength < nextDisplayedValue.length &&
    previousDisplayedValue[prefixLength] === nextDisplayedValue[prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0
  while (
    suffixLength < previousDisplayedValue.length - prefixLength &&
    suffixLength < nextDisplayedValue.length - prefixLength &&
    previousDisplayedValue[previousDisplayedValue.length - suffixLength - 1] ===
      nextDisplayedValue[nextDisplayedValue.length - suffixLength - 1]
  ) {
    suffixLength += 1
  }

  const previousGraphemes = splitUserPerceivedCharacters(previousRawValue)
  const start = Array.from(previousDisplayedValue.slice(0, prefixLength)).length
  const removed = previousDisplayedValue.length - prefixLength - suffixLength
  const inserted = nextDisplayedValue.slice(
    prefixLength,
    nextDisplayedValue.length - suffixLength,
  )
  previousGraphemes.splice(start, removed, inserted)
  return previousGraphemes.join("")
}

function ShellMenu({
  title,
  description,
  items,
  selectedIndex,
  status,
  error,
  canGoBack = true,
}: {
  title: string
  description: string
  items: ShellMenuItem[]
  selectedIndex: number
  status: string
  error?: string
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
        {error ? <text fg={colors.error}>Error: {error}</text> : null}
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
        <text fg={colors.muted}>x sign out · q quit · ? toggle help</text>
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
