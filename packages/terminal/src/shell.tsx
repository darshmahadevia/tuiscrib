import { decodePasteBytes, type InputRenderable, type TerminalCapabilities, type TextareaRenderable } from "@opentui/core"
import { flushSync, useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

import {
  countUserPerceivedCharacters,
  DEFAULT_STICKY_NOTE_COLOR,
  splitUserPerceivedCharacters,
  USER_PERCEIVED_CHARACTER_SEGMENTATION_UNAVAILABLE,
  type BoardEditClaim,
  type StickyNote,
  type StickyNoteColor,
  type StickyNotePosition,
  type StickyNoteStackingDirection,
  type BoardSnapshot,
  type BoardSummary,
} from "@tuiscrib/contracts"

import {
  ServiceRequestError,
  type AuthClient,
  type BoardConnection,
  type BoardConnectionState,
  type BoardClient,
} from "./client.ts"
import {
  createCredentialStore,
  CredentialStoreError,
  type CredentialStore,
} from "./credentials.ts"
import {
  createStickyNoteDebouncer,
  validateStickyNoteEditorText,
  type StickyNoteDebouncer,
  type StickyNoteTimer,
} from "./sticky-note-editor.ts"
import { wrapStickyNoteText } from "./sticky-notes.ts"
import {
  applyCanvasNavigation,
  canvasCoordinateToScreen,
  canvasPointIsInsideRect,
  canvasRectIntersectsViewport,
  createCanvasNavigationState,
  getCanvasPanelWidth,
  getCanvasStickyNoteCardHeight,
  getCanvasViewportSize,
  CANVAS_STICKY_NOTE_CARD_WIDTH,
  sortCanvasStackingOrder,
  type CanvasDirection,
  type CanvasViewportSize,
} from "./canvas-navigation.ts"

export const MIN_TERMINAL_WIDTH = 80
export const MIN_TERMINAL_HEIGHT = 24

export type ShellMode = "navigate" | "edit"

export type TerminalShellProps = {
  label?: string
  capabilities?: TerminalCapabilities | null
  authClient?: AuthClient
  boardClient?: BoardClient
  credentialStore?: CredentialStore
  stickyNoteTimer?: StickyNoteTimer
}

type ShellOverlay = "none" | "help"
type ShellView = "home" | "boards" | "board-actions" | "canvas" | "form" | "confirmation"
type ConfirmationAction = "placeholder" | "leave"

type FormKind =
  | "sign-in"
  | "register"
  | "create-board"
  | "join-board"
  | "rename-board"
  | "filter-boards"

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

type BoardCodeNotice = {
  kind: "initial" | "rotated"
  code: string
}

type SessionState = "checking" | "signed-out" | "signed-in"

type ShellMenuItem = {
  key: string
  label: string
  description: string
}

type ProvisionalStickyNote = {
  provisionalId: string
  position: StickyNotePosition
  color: StickyNoteColor
  text: string
  status: "requesting" | "granted" | "editing"
  claimId?: string
  durableNoteId?: string
  publicationRequested: boolean
}

type EstablishedStickyNoteEdit = {
  stickyNoteId: string
  text: string
  textVersion: number
  status: "requesting" | "granted"
  claimId?: string
  dirty: boolean
  publicationRequested: boolean
  publishedText?: string
  releaseRequested: boolean
  releaseSent: boolean
  claimRequestSent: boolean
  reconnecting: boolean
}

type StickyNoteColorChoice = {
  key: string
  color: StickyNoteColor
}

type StickyNoteEditorDraft = {
  editorId: string
  text: string
  status: string
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
  { key: "r", label: "rename Board", description: "Rename this Board as the Owner" },
  { key: "t", label: "rotate Join Code", description: "Replace this Board's Join Code as the Owner" },
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
    fields: [{
      id: "joinCode",
      label: "Join Code",
      placeholder: "grouped code",
      sensitive: true,
      maxLength: 32,
    }],
  },
  "rename-board": {
    title: "Rename Board",
    description: "Set a new human-readable label for the selected Board.",
    fields: [{ id: "name", label: "Board name", placeholder: "new name" }],
  },
  "filter-boards": {
    title: "Filter Boards",
    description: "Show Memberships whose Board name contains this text.",
    fields: [{ id: "filter", label: "Board name filter", placeholder: "contains…", maxLength: 80 }],
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

const stickyNoteColorChoices: StickyNoteColorChoice[] = [
  { key: "1", color: "amber" },
  { key: "2", color: "blue" },
  { key: "3", color: "cyan" },
  { key: "4", color: "green" },
  { key: "5", color: "magenta" },
  { key: "6", color: "red" },
  { key: "7", color: "violet" },
  { key: "8", color: "yellow" },
]

function stickyNoteCanvasFootprint(note: StickyNote) {
  return {
    left: note.position.x,
    top: note.position.y,
    width: CANVAS_STICKY_NOTE_CARD_WIDTH,
    height: getCanvasStickyNoteCardHeight(wrapStickyNoteText(note.text).length),
  }
}

function stickyNotesAtCanvasCursor(
  notes: readonly StickyNote[],
  cursor: StickyNotePosition,
  direction: "back-to-front" | "front-to-back" = "front-to-back",
): StickyNote[] {
  return sortCanvasStackingOrder(
    notes.filter((note) => canvasPointIsInsideRect(cursor, stickyNoteCanvasFootprint(note))),
    direction,
  )
}

export type TerminalColorMode = "ansi256" | "truecolor" | "unknown"

export function getTerminalColorMode(
  capabilities: Pick<TerminalCapabilities, "ansi256" | "rgb"> | null | undefined,
): TerminalColorMode {
  if (!capabilities?.ansi256) {
    return "unknown"
  }
  return capabilities.rgb ? "truecolor" : "ansi256"
}

export function TerminalShell({
  label = "local",
  capabilities: capabilitiesOverride,
  authClient,
  boardClient,
  credentialStore: credentialStoreOverride,
  stickyNoteTimer,
}: TerminalShellProps) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const canvasViewportSize = getCanvasViewportSize(width, height)
  const [credentialStore] = useState<CredentialStore>(
    () => credentialStoreOverride ?? createCredentialStore(),
  )
  const [detectedCapabilities, setDetectedCapabilities] = useState(renderer.capabilities)
  const [overlay, setOverlay] = useState<ShellOverlay>("none")
  const [view, setView] = useState<ShellView>("home")
  const [mode, setMode] = useState<ShellMode>("navigate")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedBoardIndex, setSelectedBoardIndex] = useState(0)
  const [formKind, setFormKind] = useState<FormKind | null>(null)
  const [formReturnView, setFormReturnView] = useState<ShellView>("home")
  const [formInitialKey, setFormInitialKey] = useState<string | null>(null)
  const [confirmationReturnView, setConfirmationReturnView] = useState<ShellView>("boards")
  const [confirmationAction, setConfirmationAction] = useState<ConfirmationAction>("placeholder")
  const [notice, setNotice] = useState<ShellNotice | null>(null)
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [boardFilter, setBoardFilter] = useState("")
  const [boardsPending, setBoardsPending] = useState(false)
  const [boardCodeNotice, setBoardCodeNotice] = useState<BoardCodeNotice | null>(null)
  const [boardSnapshot, setBoardSnapshot] = useState<BoardSnapshot | null>(null)
  const [boardConnectionState, setBoardConnectionState] = useState<BoardConnectionState | null>(null)
  const [canvasCursor, setCanvasCursor] = useState<StickyNotePosition>(
    () => createCanvasNavigationState().cursor,
  )
  const [canvasViewport, setCanvasViewport] = useState<StickyNotePosition>(
    () => createCanvasNavigationState().viewport,
  )
  const [selectedStickyNoteId, setSelectedStickyNoteId] = useState<string | null>(null)
  const [colorPickerStickyNoteId, setColorPickerStickyNoteId] = useState<string | null>(null)
  const [provisionalStickyNote, setProvisionalStickyNote] =
    useState<ProvisionalStickyNote | null>(null)
  const [establishedStickyNoteEdit, setEstablishedStickyNoteEdit] =
    useState<EstablishedStickyNoteEdit | null>(null)
  const [boardOpenPending, setBoardOpenPending] = useState(false)
  const [formPending, setFormPending] = useState(false)
  const [sessionState, setSessionState] = useState<SessionState>(
    authClient ? "checking" : "signed-out",
  )
  const [authenticatedUsername, setAuthenticatedUsername] = useState<string | null>(null)
  const [signOutPending, setSignOutPending] = useState(false)
  const [boardActionPending, setBoardActionPending] = useState(false)
  const overlayRef = useRef(overlay)
  const viewRef = useRef(view)
  const modeRef = useRef(mode)
  const selectedIndexRef = useRef(selectedIndex)
  const selectedBoardIndexRef = useRef(selectedBoardIndex)
  const sessionStateRef = useRef(sessionState)
  const authenticatedUsernameRef = useRef<string | null>(authenticatedUsername)
  const boardFilterRef = useRef(boardFilter)
  const signOutPendingRef = useRef(signOutPending)
  const confirmationActionRef = useRef(confirmationAction)
  const boardActionPendingRef = useRef(boardActionPending)
  const boardConnectionRef = useRef<BoardConnection | null>(null)
  const activeBoardIdRef = useRef<string | null>(null)
  const boardConnectionGenerationRef = useRef(0)
  const boardConnectionStateRef = useRef<BoardConnectionState | null>(boardConnectionState)
  const boardSnapshotRef = useRef<BoardSnapshot | null>(boardSnapshot)
  const canvasCursorRef = useRef(canvasCursor)
  const canvasViewportRef = useRef(canvasViewport)
  const selectedStickyNoteIdRef = useRef<string | null>(selectedStickyNoteId)
  const colorPickerStickyNoteIdRef = useRef<string | null>(colorPickerStickyNoteId)
  const provisionalStickyNoteRef = useRef<ProvisionalStickyNote | null>(null)
  const establishedStickyNoteEditRef = useRef<EstablishedStickyNoteEdit | null>(
    establishedStickyNoteEdit,
  )
  const cancelledProvisionalIdsRef = useRef(new Set<string>())
  const cancelledStickyNoteEditIdsRef = useRef(new Set<string>())
  const cancelledStickyNoteEditRequestsRef = useRef(new Set<string>())
  const stickyNoteDebouncerRef = useRef<StickyNoteDebouncer | null>(null)
  overlayRef.current = overlay
  viewRef.current = view
  modeRef.current = mode
  selectedIndexRef.current = selectedIndex
  selectedBoardIndexRef.current = selectedBoardIndex
  sessionStateRef.current = sessionState
  authenticatedUsernameRef.current = authenticatedUsername
  boardFilterRef.current = boardFilter
  signOutPendingRef.current = signOutPending
  confirmationActionRef.current = confirmationAction
  boardActionPendingRef.current = boardActionPending
  boardConnectionStateRef.current = boardConnectionState
  boardSnapshotRef.current = boardSnapshot
  canvasCursorRef.current = canvasCursor
  canvasViewportRef.current = canvasViewport
  selectedStickyNoteIdRef.current = selectedStickyNoteId
  colorPickerStickyNoteIdRef.current = colorPickerStickyNoteId
  provisionalStickyNoteRef.current = provisionalStickyNote
  establishedStickyNoteEditRef.current = establishedStickyNoteEdit

  function resetCanvasNavigation(options: { render?: boolean } = {}) {
    const initial = createCanvasNavigationState()
    canvasCursorRef.current = initial.cursor
    canvasViewportRef.current = initial.viewport
    if (options.render !== false) {
      flushSync(() => {
        setCanvasCursor(initial.cursor)
        setCanvasViewport(initial.viewport)
      })
    }
    return initial
  }

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

  function updateProvisionalStickyNote(
    update: (current: ProvisionalStickyNote | null) => ProvisionalStickyNote | null,
  ) {
    const next = update(provisionalStickyNoteRef.current)
    provisionalStickyNoteRef.current = next
    flushSync(() => setProvisionalStickyNote(next))
  }

  function updateEstablishedStickyNoteEdit(
    update: (current: EstablishedStickyNoteEdit | null) => EstablishedStickyNoteEdit | null,
  ) {
    const next = update(establishedStickyNoteEditRef.current)
    establishedStickyNoteEditRef.current = next
    flushSync(() => setEstablishedStickyNoteEdit(next))
  }

  function sharedBoardMutationsEnabled(): boolean {
    return !boardClient?.openBoard || boardConnectionStateRef.current === "connected"
  }

  function discardLocalBoardWorkAfterConnectionLoss(
    preserveEstablishedEdit = false,
  ): void {
    stickyNoteDebouncerRef.current?.cancel()
    provisionalStickyNoteRef.current = null
    colorPickerStickyNoteIdRef.current = null
    cancelledProvisionalIdsRef.current.clear()
    if (!preserveEstablishedEdit) {
      cancelledStickyNoteEditIdsRef.current.clear()
      cancelledStickyNoteEditRequestsRef.current.clear()
    }
    boardSnapshotRef.current = null

    const currentEdit = establishedStickyNoteEditRef.current
    const preservedEdit = preserveEstablishedEdit && currentEdit
      ? {
          ...currentEdit,
          status: "requesting" as const,
          publicationRequested: false,
          publishedText: undefined,
          releaseSent: false,
          claimRequestSent: false,
          reconnecting: true,
        }
      : null
    establishedStickyNoteEditRef.current = preservedEdit
    flushSync(() => {
      setProvisionalStickyNote(null)
      setEstablishedStickyNoteEdit(preservedEdit)
      setColorPickerStickyNoteId(null)
      setBoardSnapshot(null)
      setMode("navigate")
    })
  }

  function renderBoardConnectionState(state: BoardConnectionState): void {
    boardConnectionStateRef.current = state
    if (state === "connected") {
      flushSync(() => {
        setBoardConnectionState(state)
        setBoardOpenPending(false)
      })
      return
    }

    const transient = state === "connecting" ||
      state === "reconnecting" ||
      state === "waking" ||
      state === "unavailable"
    discardLocalBoardWorkAfterConnectionLoss(transient)
    flushSync(() => {
      setBoardConnectionState(state)
      setBoardOpenPending(state === "connecting")
      if (state === "reconnecting") {
        setNotice({ kind: "status", message: "Reconnecting to the Tuiscrib Service…" })
      }
    })
  }

  function publishFirstStickyNoteSnapshot(text: string) {
    const draft = provisionalStickyNoteRef.current
    const connection = boardConnectionRef.current
    if (
      !sharedBoardMutationsEnabled() ||
      !draft ||
      !connection ||
      !draft.claimId ||
      draft.publicationRequested ||
      text.length === 0
    ) {
      return
    }
    if (draft.status === "requesting") {
      return
    }

    const next = { ...draft, publicationRequested: true }
    provisionalStickyNoteRef.current = next
    flushSync(() => setProvisionalStickyNote(next))
    try {
      connection.send({
        type: "publish_sticky_note",
        claimId: draft.claimId,
        provisionalId: draft.provisionalId,
        text,
      })
    } catch (error) {
      const current = provisionalStickyNoteRef.current
      if (current?.provisionalId === draft.provisionalId) {
        updateProvisionalStickyNote((value) =>
          value && value.provisionalId === draft.provisionalId
            ? { ...value, publicationRequested: false }
            : value,
        )
      }
      flushSync(() => setNotice({ kind: "error", message: formatBoardError(error) }))
    }
  }

  function publishEstablishedStickyNoteSnapshot(text: string) {
    const edit = establishedStickyNoteEditRef.current
    const connection = boardConnectionRef.current
    if (
      !sharedBoardMutationsEnabled() ||
      !edit ||
      !connection ||
      !edit.claimId ||
      edit.status !== "granted" ||
      edit.publicationRequested
    ) {
      return
    }

    updateEstablishedStickyNoteEdit((current) =>
      current && current.stickyNoteId === edit.stickyNoteId
        ? { ...current, publicationRequested: true, publishedText: text }
        : current,
    )
    try {
      connection.send({
        type: "publish_sticky_note_edit",
        claimId: edit.claimId,
        stickyNoteId: edit.stickyNoteId,
        text,
        expectedTextVersion: edit.textVersion,
      })
    } catch (error) {
      updateEstablishedStickyNoteEdit((current) =>
        current && current.stickyNoteId === edit.stickyNoteId
          ? { ...current, publicationRequested: false, publishedText: undefined }
          : current,
      )
      flushSync(() => setNotice({ kind: "error", message: formatBoardError(error) }))
    }
  }

  function publishPendingStickyNoteSnapshot(text: string) {
    if (provisionalStickyNoteRef.current) {
      publishFirstStickyNoteSnapshot(text)
      return
    }
    publishEstablishedStickyNoteSnapshot(text)
  }

  if (stickyNoteDebouncerRef.current === null) {
    stickyNoteDebouncerRef.current = createStickyNoteDebouncer({
      schedule: stickyNoteTimer?.schedule,
      cancel: stickyNoteTimer?.cancel,
      publish: publishPendingStickyNoteSnapshot,
    })
  }

  const updateCanvasNavigation = (direction: CanvasDirection, pan = false) => {
    const next = applyCanvasNavigation(
      {
        cursor: canvasCursorRef.current,
        viewport: canvasViewportRef.current,
      },
      direction,
      canvasViewportSize,
      { pan },
    )
    canvasCursorRef.current = next.cursor
    canvasViewportRef.current = next.viewport
    const notes = boardSnapshotRef.current?.stickyNotes ?? []
    const selectedStillExists = selectedStickyNoteIdRef.current !== null && notes.some(
      (note) => note.id === selectedStickyNoteIdRef.current,
    )
    const noteAtNextCursor = stickyNotesAtCanvasCursor(notes, next.cursor)[0]
    const nextSelectedStickyNoteId = selectedStillExists
      ? selectedStickyNoteIdRef.current
      : noteAtNextCursor?.id ?? null
    selectedStickyNoteIdRef.current = nextSelectedStickyNoteId
    flushSync(() => {
      setCanvasCursor(next.cursor)
      setCanvasViewport(next.viewport)
      setSelectedStickyNoteId(nextSelectedStickyNoteId)
    })
  }

  const selectedStickyNote = (): StickyNote | undefined => {
    const notes = boardSnapshotRef.current?.stickyNotes ?? []
    const selectedId = selectedStickyNoteIdRef.current
    const selected = selectedId ? notes.find((note) => note.id === selectedId) : undefined
    return selected ?? stickyNotesAtCanvasCursor(notes, canvasCursorRef.current)[0]
  }

  const cycleSelectedStickyNote = () => {
    const notes = stickyNotesAtCanvasCursor(
      boardSnapshotRef.current?.stickyNotes ?? [],
      canvasCursorRef.current,
    )
    if (notes.length === 0) {
      return
    }
    const currentIndex = notes.findIndex((note) => note.id === selectedStickyNoteIdRef.current)
    const next = notes[(currentIndex + 1) % notes.length] ?? notes[0]
    selectedStickyNoteIdRef.current = next.id
    flushSync(() => setSelectedStickyNoteId(next.id))
  }

  const closeStickyNoteColorPicker = () => {
    colorPickerStickyNoteIdRef.current = null
    flushSync(() => setColorPickerStickyNoteId(null))
  }

  const openStickyNoteColorPicker = () => {
    if (modeRef.current !== "navigate") {
      return
    }
    const note = selectedStickyNote()
    if (!note) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Select a Sticky Note before opening the Color picker." })
      })
      return
    }
    selectedStickyNoteIdRef.current = note.id
    colorPickerStickyNoteIdRef.current = note.id
    flushSync(() => {
      setSelectedStickyNoteId(note.id)
      setColorPickerStickyNoteId(note.id)
      setNotice({ kind: "status", message: "Choose a decorative Color; Color has no workflow meaning." })
    })
  }

  const recolorSelectedStickyNote = (color: StickyNoteColor) => {
    if (!sharedBoardMutationsEnabled()) {
      closeStickyNoteColorPicker()
      flushSync(() => {
        setNotice({ kind: "error", message: "Shared mutations are disabled while the Board reconnects." })
      })
      return
    }
    const stickyNoteId = colorPickerStickyNoteIdRef.current
    const connection = boardConnectionRef.current
    if (!stickyNoteId || !connection) {
      closeStickyNoteColorPicker()
      return
    }
    try {
      connection.send({
        type: "recolor_sticky_note",
        stickyNoteId,
        color,
      })
      closeStickyNoteColorPicker()
      flushSync(() => {
        setNotice({ kind: "status", message: `Waiting for durable Color ${color} acknowledgement…` })
      })
    } catch (error) {
      flushSync(() => setNotice({ kind: "error", message: formatBoardError(error) }))
    }
  }

  const reorderSelectedStickyNote = (direction: StickyNoteStackingDirection) => {
    if (!sharedBoardMutationsEnabled()) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Shared mutations are disabled while the Board reconnects." })
      })
      return
    }
    const note = selectedStickyNote()
    const connection = boardConnectionRef.current
    if (!note) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Select a Sticky Note before changing its Stacking Order." })
      })
      return
    }
    if (!connection) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Open a live Board before changing Stacking Order." })
      })
      return
    }
    selectedStickyNoteIdRef.current = note.id
    flushSync(() => setSelectedStickyNoteId(note.id))
    try {
      connection.send({
        type: "reorder_sticky_note",
        stickyNoteId: note.id,
        direction,
      })
      flushSync(() => {
        setNotice({
          kind: "status",
          message: `Waiting for durable Stacking Order ${direction} acknowledgement…`,
        })
      })
    } catch (error) {
      flushSync(() => setNotice({ kind: "error", message: formatBoardError(error) }))
    }
  }

  const moveSelectedStickyNote = (direction: CanvasDirection) => {
    if (!sharedBoardMutationsEnabled()) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Shared mutations are disabled while the Board reconnects." })
      })
      return
    }
    const note = selectedStickyNote()
    const connection = boardConnectionRef.current
    if (!note) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Select a Sticky Note before moving it." })
      })
      return
    }
    if (!connection) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Open a live Board before moving a Sticky Note." })
      })
      return
    }
    selectedStickyNoteIdRef.current = note.id
    flushSync(() => setSelectedStickyNoteId(note.id))
    try {
      connection.send({
        type: "move_sticky_note",
        stickyNoteId: note.id,
        direction,
      })
      flushSync(() => {
        setNotice({
          kind: "status",
          message: `Waiting for durable Position ${direction} acknowledgement…`,
        })
      })
    } catch (error) {
      flushSync(() => setNotice({ kind: "error", message: formatBoardError(error) }))
    }
  }

  const startProvisionalStickyNote = () => {
    if (provisionalStickyNoteRef.current || establishedStickyNoteEditRef.current) {
      return
    }
    if (!sharedBoardMutationsEnabled()) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Shared mutations are disabled while the Board reconnects." })
      })
      return
    }
    const connection = boardConnectionRef.current
    if (!connection) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Open a live Board before creating a Sticky Note." })
      })
      return
    }

    const draft: ProvisionalStickyNote = {
      provisionalId: crypto.randomUUID(),
      position: { ...canvasCursorRef.current },
      color: DEFAULT_STICKY_NOTE_COLOR,
      text: "",
      status: "requesting",
      publicationRequested: false,
    }
    provisionalStickyNoteRef.current = draft
    flushSync(() => {
      setProvisionalStickyNote(draft)
      setMode("edit")
      setNotice({ kind: "status", message: "Requesting Sticky Note creation authority…" })
    })
    try {
      connection.send({
        type: "begin_sticky_note",
        provisionalId: draft.provisionalId,
        position: draft.position,
        color: draft.color,
      })
    } catch (error) {
      provisionalStickyNoteRef.current = null
      flushSync(() => {
        setProvisionalStickyNote(null)
        setMode("navigate")
        setNotice({ kind: "error", message: formatBoardError(error) })
      })
    }
  }

  const startEstablishedStickyNoteEdit = () => {
    if (provisionalStickyNoteRef.current || establishedStickyNoteEditRef.current) {
      return
    }
    if (!sharedBoardMutationsEnabled()) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Shared mutations are disabled while the Board reconnects." })
      })
      return
    }
    const connection = boardConnectionRef.current
    if (!connection) {
      flushSync(() => setMode("edit"))
      return
    }
    const note = selectedStickyNote()
    if (!note) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Select an established Sticky Note before editing." })
      })
      return
    }
    if (cancelledStickyNoteEditIdsRef.current.has(note.id)) {
      flushSync(() => {
        setNotice({ kind: "status", message: "Finishing the previous Sticky Note Edit Claim…" })
      })
      return
    }

    const edit: EstablishedStickyNoteEdit = {
      stickyNoteId: note.id,
      text: note.text,
      textVersion: note.textVersion,
      status: "requesting",
      dirty: false,
      publicationRequested: false,
      releaseRequested: false,
      releaseSent: false,
      claimRequestSent: false,
      reconnecting: false,
    }
    selectedStickyNoteIdRef.current = note.id
    establishedStickyNoteEditRef.current = edit
    flushSync(() => {
      setSelectedStickyNoteId(note.id)
      setEstablishedStickyNoteEdit(edit)
      setMode("edit")
      setNotice({ kind: "status", message: "Requesting Sticky Note Edit Claim…" })
    })
    try {
      connection.send({
        type: "begin_sticky_note_edit",
        stickyNoteId: note.id,
      })
    } catch (error) {
      establishedStickyNoteEditRef.current = null
      flushSync(() => {
        setEstablishedStickyNoteEdit(null)
        setMode("navigate")
        setNotice({ kind: "error", message: formatBoardError(error) })
      })
    }
  }

  const releaseProvisionalStickyNote = () => {
    stickyNoteDebouncerRef.current?.cancel()
    const draft = provisionalStickyNoteRef.current
    if (draft) {
      if (draft.claimId) {
        try {
          boardConnectionRef.current?.send({
            type: "release_sticky_note_creation",
            claimId: draft.claimId,
            provisionalId: draft.provisionalId,
          })
        } catch {
          // The connection is already closing; the service will release the claim on disconnect.
        }
      } else {
        cancelledProvisionalIdsRef.current.add(draft.provisionalId)
      }
    }
    provisionalStickyNoteRef.current = null
    flushSync(() => {
      setProvisionalStickyNote(null)
      setMode("navigate")
    })
  }

  const sendEstablishedStickyNoteRelease = (): boolean => {
    const edit = establishedStickyNoteEditRef.current
    const connection = boardConnectionRef.current
    if (
      !edit?.claimId ||
      edit.releaseSent ||
      !connection ||
      boardConnectionStateRef.current !== "connected"
    ) {
      return false
    }
    try {
      connection.send({
        type: "release_sticky_note_edit",
        claimId: edit.claimId,
        stickyNoteId: edit.stickyNoteId,
      })
      updateEstablishedStickyNoteEdit((current) =>
        current && current.stickyNoteId === edit.stickyNoteId
          ? { ...current, releaseSent: true }
          : current,
      )
      return true
    } catch {
      return false
    }
  }

  const clearEstablishedStickyNoteEdit = () => {
    establishedStickyNoteEditRef.current = null
    flushSync(() => setEstablishedStickyNoteEdit(null))
  }

  const releaseEstablishedStickyNoteEdit = () => {
    const edit = establishedStickyNoteEditRef.current
    if (!edit) {
      flushSync(() => setMode("navigate"))
      return
    }

    stickyNoteDebouncerRef.current?.flush()
    const afterFlush = establishedStickyNoteEditRef.current
    flushSync(() => setMode("navigate"))
    if (!afterFlush) {
      return
    }
    if (!afterFlush.claimId || afterFlush.status === "requesting" || afterFlush.reconnecting) {
      cancelledStickyNoteEditIdsRef.current.add(afterFlush.stickyNoteId)
      clearEstablishedStickyNoteEdit()
      return
    }

    if (
      afterFlush.publicationRequested &&
      afterFlush.text !== afterFlush.publishedText
    ) {
      updateEstablishedStickyNoteEdit((current) =>
        current && current.stickyNoteId === afterFlush.stickyNoteId
          ? { ...current, releaseRequested: true }
          : current,
      )
      return
    }

    if (!sendEstablishedStickyNoteRelease()) {
      cancelledStickyNoteEditIdsRef.current.add(afterFlush.stickyNoteId)
    }
    clearEstablishedStickyNoteEdit()
  }

  const handleStickyNoteCreationClaimGranted = (claim: {
    provisionalId: string
    claimId: string
    position: StickyNotePosition
    color: StickyNoteColor
  }) => {
    if (cancelledProvisionalIdsRef.current.delete(claim.provisionalId)) {
      try {
        boardConnectionRef.current?.send({
          type: "release_sticky_note_creation",
          claimId: claim.claimId,
          provisionalId: claim.provisionalId,
        })
      } catch {
        // The connection may have closed between the local cancellation and this acknowledgement.
      }
      return
    }
    const draft = provisionalStickyNoteRef.current
    if (!draft || draft.provisionalId !== claim.provisionalId) {
      return
    }
    updateProvisionalStickyNote((current) =>
      current && current.provisionalId === claim.provisionalId
        ? {
            ...current,
            claimId: claim.claimId,
            position: claim.position,
            color: claim.color,
            status: "granted",
          }
        : current,
    )
    if (draft.text.length > 0) {
      stickyNoteDebouncerRef.current?.schedule(draft.text)
    }
    flushSync(() => setNotice({ kind: "status", message: "Sticky Note creation authority granted." }))
  }

  const handleStickyNoteEditClaimGranted = (claim: {
    stickyNoteId: string
    claimId: string
    stickyNote: StickyNote
  }) => {
    cancelledStickyNoteEditRequestsRef.current.delete(claim.stickyNoteId)
    if (cancelledStickyNoteEditIdsRef.current.delete(claim.stickyNoteId)) {
      try {
        boardConnectionRef.current?.send({
          type: "release_sticky_note_edit",
          claimId: claim.claimId,
          stickyNoteId: claim.stickyNoteId,
        })
      } catch {
        // The connection may have closed between local cancellation and this acknowledgement.
      }
      return
    }

    const edit = establishedStickyNoteEditRef.current
    if (!edit || edit.stickyNoteId !== claim.stickyNoteId) {
      try {
        boardConnectionRef.current?.send({
          type: "release_sticky_note_edit",
          claimId: claim.claimId,
          stickyNoteId: claim.stickyNoteId,
        })
      } catch {
        // A stale grant cannot be released after the socket has already moved on.
      }
      return
    }
    const wasReconnecting = edit.reconnecting
    const previousClaimId = edit.claimId
    mergeStickyNoteIntoSnapshot(claim.stickyNote, boardSnapshotRef.current?.revision ?? 0)
    if (wasReconnecting && previousClaimId && previousClaimId !== claim.claimId) {
      try {
        boardConnectionRef.current?.send({
          type: "release_sticky_note_edit",
          claimId: claim.claimId,
          stickyNoteId: claim.stickyNoteId,
        })
      } catch {
        // The authoritative snapshot has already won; the service will fence this claim.
      }
      stickyNoteDebouncerRef.current?.cancel()
      establishedStickyNoteEditRef.current = null
      flushSync(() => {
        setEstablishedStickyNoteEdit(null)
        setMode("navigate")
        setNotice({
          kind: "error",
          message: "Edit Claim was lost; authoritative Sticky Note text was reloaded.",
        })
      })
      return
    }

    const text = wasReconnecting && edit.dirty && edit.text !== claim.stickyNote.text
      ? edit.text
      : claim.stickyNote.text
    const next: EstablishedStickyNoteEdit = {
      ...edit,
      claimId: claim.claimId,
      text,
      textVersion: claim.stickyNote.textVersion,
      status: "granted",
      dirty: text !== claim.stickyNote.text,
      publicationRequested: false,
      publishedText: undefined,
      claimRequestSent: false,
      reconnecting: false,
    }
    establishedStickyNoteEditRef.current = next
    flushSync(() => {
      setEstablishedStickyNoteEdit(next)
      if (wasReconnecting) {
        setMode("edit")
      }
    })
    if (text !== claim.stickyNote.text) {
      stickyNoteDebouncerRef.current?.schedule(text)
    }
    flushSync(() => setNotice({
      kind: "status",
      message: wasReconnecting
        ? "Sticky Note Edit Claim restored; local draft preserved."
        : "Sticky Note Edit Claim granted.",
    }))
  }

  const mergeStickyNoteIntoSnapshot = (note: StickyNote, revision: number) => {
    const current = boardSnapshotRef.current
    if (!current) {
      return
    }
    const stickyNotes = current.stickyNotes ?? []
    const existingIndex = stickyNotes.findIndex((currentNote) => currentNote.id === note.id)
    const nextNotes = [...stickyNotes]
    if (existingIndex === -1) {
      nextNotes.push(note)
    } else {
      nextNotes[existingIndex] = note
    }
    const sortedNotes = sortCanvasStackingOrder(nextNotes)
    const nextSnapshot = { ...current, revision, stickyNotes: sortedNotes }
    boardSnapshotRef.current = nextSnapshot
    flushSync(() => setBoardSnapshot(nextSnapshot))
  }

  const editClaimBelongsToAuthenticatedMember = (claim: BoardEditClaim): boolean =>
    authenticatedUsernameRef.current !== null &&
    claim.holder.username === authenticatedUsernameRef.current

  const reconcileEstablishedStickyNoteEditFromSnapshot = (snapshot: BoardSnapshot): void => {
    const edit = establishedStickyNoteEditRef.current
    if (!edit?.reconnecting) {
      return
    }

    const note = snapshot.stickyNotes?.find((currentNote) => currentNote.id === edit.stickyNoteId)
    const claim = snapshot.editClaims?.find(
      (currentClaim) => currentClaim.stickyNoteId === edit.stickyNoteId,
    )

    if (edit.releaseRequested) {
      cancelledStickyNoteEditIdsRef.current.add(edit.stickyNoteId)
      stickyNoteDebouncerRef.current?.cancel()
      establishedStickyNoteEditRef.current = null
      flushSync(() => {
        setEstablishedStickyNoteEdit(null)
        setMode("navigate")
      })
      return
    }

    if (!note || !claim || !editClaimBelongsToAuthenticatedMember(claim)) {
      stickyNoteDebouncerRef.current?.cancel()
      establishedStickyNoteEditRef.current = null
      flushSync(() => {
        setEstablishedStickyNoteEdit(null)
        setMode("navigate")
        setNotice({
          kind: "error",
          message: "Edit Claim was lost; authoritative Sticky Note text was reloaded.",
        })
      })
      return
    }

    const text = edit.dirty && edit.text !== note.text ? edit.text : note.text
    const next: EstablishedStickyNoteEdit = {
      ...edit,
      text,
      textVersion: note.textVersion,
      status: "requesting",
      dirty: text !== note.text,
      publicationRequested: false,
      publishedText: undefined,
      claimRequestSent: edit.claimRequestSent,
      reconnecting: true,
    }
    establishedStickyNoteEditRef.current = next
    flushSync(() => {
      setEstablishedStickyNoteEdit(next)
      setMode("navigate")
      setNotice({ kind: "status", message: "Reconnected; restoring the Sticky Note Edit Claim…" })
    })
  }

  const releaseCancelledEditClaimsAfterReconnect = (snapshot: BoardSnapshot): void => {
    const connection = boardConnectionRef.current
    if (!connection || boardConnectionStateRef.current !== "connected") {
      return
    }

    for (const stickyNoteId of [...cancelledStickyNoteEditIdsRef.current]) {
      const claim = snapshot.editClaims?.find(
        (currentClaim) => currentClaim.stickyNoteId === stickyNoteId,
      )
      if (!claim) {
        cancelledStickyNoteEditIdsRef.current.delete(stickyNoteId)
        cancelledStickyNoteEditRequestsRef.current.delete(stickyNoteId)
        continue
      }
      if (!editClaimBelongsToAuthenticatedMember(claim)) {
        cancelledStickyNoteEditIdsRef.current.delete(stickyNoteId)
        cancelledStickyNoteEditRequestsRef.current.delete(stickyNoteId)
        continue
      }
      if (cancelledStickyNoteEditRequestsRef.current.has(stickyNoteId)) {
        continue
      }

      cancelledStickyNoteEditRequestsRef.current.add(stickyNoteId)
      try {
        connection.send({ type: "begin_sticky_note_edit", stickyNoteId })
      } catch {
        cancelledStickyNoteEditRequestsRef.current.delete(stickyNoteId)
      }
    }
  }

  const requestEstablishedStickyNoteEditReclaim = (snapshot: BoardSnapshot): void => {
    const edit = establishedStickyNoteEditRef.current
    const connection = boardConnectionRef.current
    if (
      !edit?.reconnecting ||
      edit.releaseRequested ||
      edit.claimRequestSent ||
      !connection ||
      boardConnectionStateRef.current !== "connected" ||
      cancelledStickyNoteEditIdsRef.current.has(edit.stickyNoteId)
    ) {
      return
    }

    const claim = snapshot.editClaims?.find(
      (currentClaim) => currentClaim.stickyNoteId === edit.stickyNoteId,
    )
    if (!claim || !editClaimBelongsToAuthenticatedMember(claim)) {
      return
    }

    const next = { ...edit, claimRequestSent: true }
    establishedStickyNoteEditRef.current = next
    flushSync(() => setEstablishedStickyNoteEdit(next))
    try {
      connection.send({
        type: "begin_sticky_note_edit",
        stickyNoteId: edit.stickyNoteId,
      })
    } catch (error) {
      establishedStickyNoteEditRef.current = {
        ...next,
        claimRequestSent: false,
      }
      flushSync(() => {
        setEstablishedStickyNoteEdit(establishedStickyNoteEditRef.current)
        setNotice({ kind: "error", message: formatBoardError(error) })
      })
    }
  }

  const handleStickyNoteCreated = (event: {
    revision: number
    provisionalId?: string
    stickyNote: StickyNote
  }) => {
    mergeStickyNoteIntoSnapshot(event.stickyNote, event.revision)
    selectedStickyNoteIdRef.current = event.stickyNote.id
    flushSync(() => setSelectedStickyNoteId(event.stickyNote.id))
    const draft = provisionalStickyNoteRef.current
    if (event.provisionalId && draft?.provisionalId === event.provisionalId) {
      stickyNoteDebouncerRef.current?.cancel()
      updateProvisionalStickyNote((current) =>
        current && current.provisionalId === event.provisionalId
          ? {
              ...current,
              text: event.stickyNote.text,
              status: "editing",
              durableNoteId: event.stickyNote.id,
              publicationRequested: true,
            }
          : current,
      )
      flushSync(() => {
        setNotice({
          kind: "status",
          message: `Sticky Note created by ${event.stickyNote.authorship.member.username}.`,
        })
      })
    }
  }

  const handleStickyNoteUpdated = (event: {
    revision: number
    stickyNote: StickyNote
  }) => {
    mergeStickyNoteIntoSnapshot(event.stickyNote, event.revision)
    const edit = establishedStickyNoteEditRef.current
    if (!edit || edit.stickyNoteId !== event.stickyNote.id || !edit.publicationRequested) {
      return
    }

    const localText = edit.text
    const matchesPublishedText = localText === event.stickyNote.text
    const next: EstablishedStickyNoteEdit = {
      ...edit,
      textVersion: event.stickyNote.textVersion,
      publicationRequested: false,
      publishedText: undefined,
    }
    establishedStickyNoteEditRef.current = next
    flushSync(() => setEstablishedStickyNoteEdit(next))
    if (!matchesPublishedText) {
      stickyNoteDebouncerRef.current?.schedule(localText)
      return
    }
    if (edit.releaseRequested) {
      sendEstablishedStickyNoteRelease()
      clearEstablishedStickyNoteEdit()
    }
  }

  const handleStickyNoteRecolored = (event: {
    revision: number
    stickyNote: StickyNote
  }) => {
    mergeStickyNoteIntoSnapshot(event.stickyNote, event.revision)
    selectedStickyNoteIdRef.current = event.stickyNote.id
    flushSync(() => {
      setSelectedStickyNoteId(event.stickyNote.id)
      setNotice({
        kind: "status",
        message: `Sticky Note Color committed as ${event.stickyNote.color}.`,
      })
    })
  }

  const handleStickyNoteMoved = (event: {
    revision: number
    stickyNote: StickyNote
  }) => {
    mergeStickyNoteIntoSnapshot(event.stickyNote, event.revision)
    selectedStickyNoteIdRef.current = event.stickyNote.id
    flushSync(() => {
      setSelectedStickyNoteId(event.stickyNote.id)
      setNotice({
        kind: "status",
        message: `Sticky Note Position committed at Board revision ${event.revision}.`,
      })
    })
  }

  const handleStickyNoteReordered = (event: {
    revision: number
    stickyNote: StickyNote
    affectedStickyNotes?: StickyNote[]
  }) => {
    for (const note of event.affectedStickyNotes ?? [event.stickyNote]) {
      mergeStickyNoteIntoSnapshot(note, event.revision)
    }
    flushSync(() => {
      setNotice({
        kind: "status",
        message: `Sticky Note Stacking Order committed at Board revision ${event.revision}.`,
      })
    })
  }

  const handleStickyNoteCommandError = (commandError: {
    code: string
    error: string
    claimHolder?: { username: string }
    claimConnection?: "connected" | "disconnected"
    authoritative?: { revision: number; stickyNote: StickyNote }
  }) => {
    if (commandError.code === "creation_claim_unavailable") {
      stickyNoteDebouncerRef.current?.cancel()
      provisionalStickyNoteRef.current = null
      flushSync(() => {
        setProvisionalStickyNote(null)
        setMode("navigate")
        setNotice({ kind: "error", message: "Another Member already owns that Sticky Note creation." })
      })
      return
    }
    if (commandError.code === "edit_claim_unavailable") {
      stickyNoteDebouncerRef.current?.cancel()
      establishedStickyNoteEditRef.current = null
      flushSync(() => {
        setEstablishedStickyNoteEdit(null)
        setMode("navigate")
        setNotice({
          kind: "error",
          message: commandError.claimHolder
            ? `Edit Claim unavailable; holder: ${commandError.claimHolder.username} (${commandError.claimConnection ?? "connected"}).`
            : commandError.error,
        })
      })
      return
    }
    if (commandError.code === "stacking_order_boundary") {
      if (commandError.authoritative) {
        mergeStickyNoteIntoSnapshot(
          commandError.authoritative.stickyNote,
          commandError.authoritative.revision,
        )
      }
      flushSync(() => setNotice({ kind: "error", message: commandError.error }))
      return
    }
    if (commandError.code === "position_boundary") {
      if (commandError.authoritative) {
        mergeStickyNoteIntoSnapshot(
          commandError.authoritative.stickyNote,
          commandError.authoritative.revision,
        )
      }
      flushSync(() => setNotice({ kind: "error", message: commandError.error }))
      return
    }
    if (commandError.code === "sticky_note_rejected" && establishedStickyNoteEditRef.current) {
      const edit = establishedStickyNoteEditRef.current
      if (edit.status === "requesting" && !edit.publicationRequested) {
        stickyNoteDebouncerRef.current?.cancel()
        establishedStickyNoteEditRef.current = null
        flushSync(() => {
          setEstablishedStickyNoteEdit(null)
          setMode("navigate")
        })
      } else if (edit.publicationRequested) {
        updateEstablishedStickyNoteEdit((current) =>
          current && current.stickyNoteId === edit.stickyNoteId
            ? { ...current, publicationRequested: false, publishedText: undefined }
            : current,
        )
        if (edit.releaseRequested) {
          sendEstablishedStickyNoteRelease()
          clearEstablishedStickyNoteEdit()
          flushSync(() => setMode("navigate"))
        }
      }
      flushSync(() => setNotice({ kind: "error", message: commandError.error }))
      return
    }
    if (commandError.code === "invalid_edit_claim") {
      if (!establishedStickyNoteEditRef.current?.publicationRequested) {
        stickyNoteDebouncerRef.current?.cancel()
        establishedStickyNoteEditRef.current = null
        flushSync(() => {
          setEstablishedStickyNoteEdit(null)
          setMode("navigate")
        })
      }
      flushSync(() => setNotice({ kind: "error", message: commandError.error }))
      return
    }
    if (commandError.code === "text_version_conflict") {
      const currentEdit = establishedStickyNoteEditRef.current
      const authoritative = commandError.authoritative?.stickyNote ??
        boardSnapshotRef.current?.stickyNotes?.find(
          (note) => note.id === currentEdit?.stickyNoteId,
        )
      const authoritativeRevision = commandError.authoritative?.revision ??
        boardSnapshotRef.current?.revision ?? 0
      if (currentEdit && authoritative) {
        stickyNoteDebouncerRef.current?.cancel()
        mergeStickyNoteIntoSnapshot(authoritative, authoritativeRevision)
        const releaseAfterConflict = currentEdit.releaseRequested
        const next: EstablishedStickyNoteEdit = {
          ...currentEdit,
          text: authoritative.text,
          textVersion: authoritative.textVersion,
          dirty: false,
          publicationRequested: false,
          publishedText: undefined,
        }
        establishedStickyNoteEditRef.current = next
        flushSync(() => setEstablishedStickyNoteEdit(releaseAfterConflict ? null : next))
        if (releaseAfterConflict) {
          establishedStickyNoteEditRef.current = null
          flushSync(() => setMode("navigate"))
        }
      }
      flushSync(() => setNotice({ kind: "error", message: commandError.error }))
      return
    }
    if (commandError.code === "empty_sticky_note") {
      updateProvisionalStickyNote((current) =>
        current ? { ...current, publicationRequested: false } : current,
      )
      flushSync(() => setNotice({ kind: "error", message: "Type text before publishing the Sticky Note." }))
      return
    }
    flushSync(() => setNotice({ kind: "error", message: commandError.error }))
  }

  const handleProvisionalStickyNoteTextChange = (text: string): boolean => {
    if (!sharedBoardMutationsEnabled()) {
      return false
    }
    const validation = validateStickyNoteEditorText(text)
    if (!validation.accepted) {
      flushSync(() => {
        setNotice({
          kind: "error",
          message: validation.error,
        })
      })
      return false
    }
    updateProvisionalStickyNote((current) => current ? { ...current, text } : current)
    if (text.length === 0) {
      stickyNoteDebouncerRef.current?.cancel()
    } else {
      stickyNoteDebouncerRef.current?.schedule(text)
    }
    return true
  }

  const handleEstablishedStickyNoteTextChange = (text: string): boolean => {
    if (!sharedBoardMutationsEnabled()) {
      return false
    }
    const validation = validateStickyNoteEditorText(text)
    if (!validation.accepted) {
      flushSync(() => setNotice({ kind: "error", message: validation.error }))
      return false
    }
    const edit = establishedStickyNoteEditRef.current
    if (!edit) {
      return false
    }
    if (text === edit.text && !edit.dirty) {
      return true
    }
    updateEstablishedStickyNoteEdit((current) =>
      current && current.stickyNoteId === edit.stickyNoteId
        ? { ...current, text, dirty: true }
        : current,
    )
    stickyNoteDebouncerRef.current?.schedule(text)
    return true
  }

  const handleActiveStickyNoteTextChange = (text: string): boolean => {
    if (provisionalStickyNoteRef.current) {
      return handleProvisionalStickyNoteTextChange(text)
    }
    if (establishedStickyNoteEditRef.current) {
      return handleEstablishedStickyNoteTextChange(text)
    }
    return false
  }

  const appendProvisionalStickyNoteText = (addition: string) => {
    const draft = provisionalStickyNoteRef.current
    if (!draft || addition.length === 0) {
      return
    }
    handleProvisionalStickyNoteTextChange(`${draft.text}${addition}`)
  }

  const appendActiveStickyNoteText = (addition: string) => {
    const provisional = provisionalStickyNoteRef.current
    if (provisional) {
      appendProvisionalStickyNoteText(addition)
      return
    }
    const edit = establishedStickyNoteEditRef.current
    if (edit) {
      handleEstablishedStickyNoteTextChange(`${edit.text}${addition}`)
    }
  }

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

  const loadBoards = async (filter: string, clearNotice = true) => {
    if (!boardClient || sessionStateRef.current !== "signed-in") {
      return
    }

    const credential = await credentialStore.load()
    if (!credential) {
      flushSync(() => {
        setNotice({ kind: "error", message: "No active Terminal Session. Sign in to continue." })
      })
      return
    }

    flushSync(() => setBoardsPending(true))
    try {
      const response = await boardClient.listBoards(credential, filter)
      flushSync(() => {
        setBoards(response.boards)
        setSelectedBoardIndex((currentIndex) =>
          response.boards.length === 0
            ? 0
            : Math.min(currentIndex, response.boards.length - 1),
        )
        setBoardFilter(filter)
        if (clearNotice) {
          setNotice(null)
        }
      })
    } catch (error) {
      flushSync(() => {
        setNotice({ kind: "error", message: formatBoardError(error) })
      })
    } finally {
      flushSync(() => setBoardsPending(false))
    }
  }

  const closeBoardConnection = () => {
    boardConnectionGenerationRef.current += 1
    stickyNoteDebouncerRef.current?.cancel()
    colorPickerStickyNoteIdRef.current = null
    releaseProvisionalStickyNote()
    const edit = establishedStickyNoteEditRef.current
    if (edit && (edit.status === "requesting" || edit.reconnecting || !edit.claimId)) {
      cancelledStickyNoteEditIdsRef.current.add(edit.stickyNoteId)
    } else if (edit?.claimId && !edit.releaseSent) {
      try {
        boardConnectionRef.current?.send({
          type: "release_sticky_note_edit",
          claimId: edit.claimId,
          stickyNoteId: edit.stickyNoteId,
        })
      } catch {
        // The connection is already closing; the service releases the claim on disconnect.
      }
    }
    establishedStickyNoteEditRef.current = null
    cancelledStickyNoteEditIdsRef.current.clear()
    boardConnectionStateRef.current = null
    flushSync(() => {
      setEstablishedStickyNoteEdit(null)
      setColorPickerStickyNoteId(null)
    })
    activeBoardIdRef.current = null
    const connection = boardConnectionRef.current
    boardConnectionRef.current = null
    connection?.close()
    flushSync(() => setBoardConnectionState(null))
  }

  useEffect(() => {
    return () => {
      stickyNoteDebouncerRef.current?.cancel()
      releaseProvisionalStickyNote()
      const edit = establishedStickyNoteEditRef.current
      if (edit && (edit.status === "requesting" || edit.reconnecting || !edit.claimId)) {
        cancelledStickyNoteEditIdsRef.current.add(edit.stickyNoteId)
      } else if (edit?.claimId && !edit.releaseSent) {
        try {
          boardConnectionRef.current?.send({
            type: "release_sticky_note_edit",
            claimId: edit.claimId,
            stickyNoteId: edit.stickyNoteId,
          })
        } catch {
          // The renderer is shutting down; the service releases the claim on disconnect.
        }
      }
      activeBoardIdRef.current = null
      boardConnectionGenerationRef.current += 1
      boardConnectionStateRef.current = null
      boardConnectionRef.current?.close()
      boardConnectionRef.current = null
      flushSync(() => setBoardConnectionState(null))
    }
  }, [])

  const openView = (nextView: ShellView) => {
    if (nextView !== "canvas") {
      closeBoardConnection()
    }
    flushSync(() => {
      setView(nextView)
      setMode("navigate")
      setSelectedIndex(0)
      if (nextView !== "form") {
        setFormKind(null)
      }
      setFormInitialKey(null)
      setConfirmationAction("placeholder")
      setNotice(null)
      setFormPending(false)
      if (nextView !== "canvas") {
        boardSnapshotRef.current = null
        setBoardSnapshot(null)
        selectedStickyNoteIdRef.current = null
        setSelectedStickyNoteId(null)
        setBoardOpenPending(false)
      }
      if (nextView !== "boards") {
        setBoardCodeNotice(null)
      }
    })
    if (nextView === "boards") {
      void loadBoards(boardFilterRef.current)
    }
  }

  const openSelectedBoard = async () => {
    const openBoard = boardClient?.openBoard
    if (!openBoard) {
      resetCanvasNavigation()
      openView("canvas")
      return
    }

    const board = boards[selectedBoardIndexRef.current]
    if (!board) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Select a Board before opening it." })
      })
      return
    }

    const credential = await credentialStore.load()
    if (!credential) {
      flushSync(() => {
        setNotice({ kind: "error", message: "No active Terminal Session. Sign in to continue." })
      })
      return
    }

    closeBoardConnection()
    resetCanvasNavigation()
    const connectionGeneration = boardConnectionGenerationRef.current
    activeBoardIdRef.current = board.id
    const isCurrentBoardConnection = () =>
      activeBoardIdRef.current === board.id &&
      boardConnectionGenerationRef.current === connectionGeneration
    flushSync(() => {
      setView("canvas")
      setMode("navigate")
      boardSnapshotRef.current = null
      setBoardSnapshot(null)
      boardConnectionStateRef.current = "connecting"
      setBoardConnectionState("connecting")
      selectedStickyNoteIdRef.current = null
      setSelectedStickyNoteId(null)
      establishedStickyNoteEditRef.current = null
      setEstablishedStickyNoteEdit(null)
      colorPickerStickyNoteIdRef.current = null
      setColorPickerStickyNoteId(null)
      setBoardOpenPending(true)
      setNotice(null)
    })

    try {
      const connection = await openBoard(credential, board.id, {
        onSnapshot: (snapshot) => {
          if (!isCurrentBoardConnection()) {
            return
          }
          const initialNavigation = resetCanvasNavigation({ render: false })
          boardConnectionStateRef.current = "connected"
          boardSnapshotRef.current = snapshot
          const selectedStillExists = selectedStickyNoteIdRef.current && snapshot.stickyNotes?.some(
            (note) => note.id === selectedStickyNoteIdRef.current,
          )
          const noteAtCursor = stickyNotesAtCanvasCursor(
            snapshot.stickyNotes ?? [],
            canvasCursorRef.current,
          )[0]
          const nextSelectedStickyNoteId = selectedStillExists
            ? selectedStickyNoteIdRef.current
            : noteAtCursor?.id ?? null
          selectedStickyNoteIdRef.current = nextSelectedStickyNoteId
          flushSync(() => {
            setCanvasCursor(initialNavigation.cursor)
            setCanvasViewport(initialNavigation.viewport)
            setBoardSnapshot(snapshot)
            setBoardConnectionState("connected")
            setSelectedStickyNoteId(nextSelectedStickyNoteId)
            setBoardOpenPending(false)
            setNotice((current) => current?.kind === "error" ? current : null)
          })
          reconcileEstablishedStickyNoteEditFromSnapshot(snapshot)
          releaseCancelledEditClaimsAfterReconnect(snapshot)
          requestEstablishedStickyNoteEditReclaim(snapshot)
        },
        onStickyNoteCreationClaimGranted: (claim) => {
          if (isCurrentBoardConnection()) {
            handleStickyNoteCreationClaimGranted(claim)
          }
        },
        onStickyNoteCreated: (event) => {
          if (isCurrentBoardConnection()) {
            handleStickyNoteCreated(event)
          }
        },
        onStickyNoteEditClaimGranted: (claim) => {
          if (isCurrentBoardConnection()) {
            handleStickyNoteEditClaimGranted(claim)
          }
        },
        onStickyNoteUpdated: (event) => {
          if (isCurrentBoardConnection()) {
            handleStickyNoteUpdated(event)
          }
        },
        onStickyNoteRecolored: (event) => {
          if (isCurrentBoardConnection()) {
            handleStickyNoteRecolored(event)
          }
        },
        onStickyNoteMoved: (event) => {
          if (isCurrentBoardConnection()) {
            handleStickyNoteMoved(event)
          }
        },
        onStickyNoteReordered: (event) => {
          if (isCurrentBoardConnection()) {
            handleStickyNoteReordered(event)
          }
        },
        onCommandError: (commandError) => {
          if (isCurrentBoardConnection()) {
            handleStickyNoteCommandError(commandError)
          }
        },
        onConnectionState: (state) => {
          if (!isCurrentBoardConnection()) {
            return
          }
          renderBoardConnectionState(state)
          if (state === "connected" && boardSnapshotRef.current) {
            releaseCancelledEditClaimsAfterReconnect(boardSnapshotRef.current)
            requestEstablishedStickyNoteEditReclaim(boardSnapshotRef.current)
          }
        },
        onError: (error) => {
          if (!isCurrentBoardConnection()) {
            return
          }
          flushSync(() => {
            setNotice({ kind: "error", message: formatBoardError(error) })
          })
        },
        onClose: () => {
          if (!isCurrentBoardConnection()) {
            return
          }
          renderBoardConnectionState("reconnecting")
        },
      })
      if (!isCurrentBoardConnection()) {
        connection.close()
        return
      }
      boardConnectionRef.current = connection
    } catch (error) {
      if (!isCurrentBoardConnection()) {
        return
      }
      flushSync(() => {
        setMode("navigate")
        setBoardOpenPending(false)
        setBoardConnectionState(boardConnectionStateRef.current ?? "unavailable")
        setNotice({ kind: "error", message: formatBoardError(error) })
      })
    }
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
      setBoardCodeNotice(null)
    })
  }

  const openConfirmation = (returnView: ShellView) => {
    flushSync(() => {
      setView("confirmation")
      setConfirmationReturnView(returnView)
      setConfirmationAction("placeholder")
      setSelectedIndex(0)
      setNotice(null)
    })
  }

  const openLeaveConfirmation = () => {
    const board = boards[selectedBoardIndexRef.current]
    if (!board) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Select a Board before leaving." })
      })
      return
    }
    if (board.role === "owner") {
      flushSync(() => {
        setNotice({ kind: "error", message: "The Owner cannot leave this Board." })
      })
      return
    }

    flushSync(() => {
      setView("confirmation")
      setConfirmationReturnView("board-actions")
      setConfirmationAction("leave")
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

  const leaveSelectedBoard = async () => {
    if (!boardClient || boardActionPendingRef.current) {
      return
    }

    const board = boards[selectedBoardIndexRef.current]
    if (!board) {
      flushSync(() => {
        setView("board-actions")
        setNotice({ kind: "error", message: "Select a Board before leaving." })
      })
      return
    }
    if (board.role === "owner") {
      flushSync(() => {
        setView("board-actions")
        setNotice({ kind: "error", message: "The Owner cannot leave this Board." })
      })
      return
    }

    flushSync(() => setBoardActionPending(true))
    try {
      const credential = await credentialStore.load()
      if (!credential) {
        throw new Error("No active Terminal Session. Sign in to continue.")
      }
      await boardClient.leaveBoard(credential, board.id)
      flushSync(() => {
        setBoards((currentBoards) =>
          currentBoards.filter((currentBoard) => currentBoard.id !== board.id),
        )
        setSelectedBoardIndex(0)
        setView("boards")
        setConfirmationAction("placeholder")
        setSelectedIndex(0)
        setNotice({ kind: "status", message: `Left Board "${board.name}".` })
        setBoardActionPending(false)
      })
      void loadBoards(boardFilterRef.current, false)
    } catch (error) {
      flushSync(() => {
        setView("board-actions")
        setNotice({ kind: "error", message: formatBoardError(error) })
        setBoardActionPending(false)
      })
    }
  }

  const rotateSelectedJoinCode = async () => {
    if (!boardClient || boardActionPendingRef.current) {
      return
    }

    const board = boards[selectedBoardIndexRef.current]
    if (!board) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Select a Board before rotating its Join Code." })
      })
      return
    }

    flushSync(() => setBoardActionPending(true))
    try {
      const credential = await credentialStore.load()
      if (!credential) {
        throw new Error("No active Terminal Session. Sign in to continue.")
      }
      const response = await boardClient.rotateJoinCode(credential, board.id)
      flushSync(() => {
        setBoards((currentBoards) =>
          currentBoards.map((currentBoard) =>
            currentBoard.id === response.board.id ? response.board : currentBoard,
          ),
        )
        setSelectedIndex(0)
        setView("boards")
        setBoardCodeNotice({ kind: "rotated", code: response.joinCode })
        setNotice({
          kind: "status",
          message: `Join Code rotated for Board "${response.board.name}".`,
        })
        setBoardActionPending(false)
      })
      void loadBoards(boardFilterRef.current, false)
    } catch (error) {
      flushSync(() => {
        setNotice({ kind: "error", message: formatBoardError(error) })
        setBoardActionPending(false)
      })
    }
  }

  const moveBoardSelection = (direction: -1 | 1) => {
    if (boards.length === 0) {
      return
    }
    const nextIndex =
      (selectedBoardIndexRef.current + direction + boards.length) % boards.length
    flushSync(() => setSelectedBoardIndex(nextIndex))
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
          setSelectedBoardIndex(0)
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

    if (formKind === "rename-board" && boardClient) {
      const board = boards[selectedBoardIndexRef.current]
      if (!board) {
        flushSync(() => {
          setNotice({ kind: "error", message: "Select a Board before renaming it." })
        })
        return
      }

      flushSync(() => setFormPending(true))
      try {
        const credential = await credentialStore.load()
        if (!credential) {
          throw new Error("No active Terminal Session. Sign in to continue.")
        }
        const response = await boardClient.renameBoard(credential, board.id, {
          name: values.name,
        })
        flushSync(() => {
          setBoards((currentBoards) =>
            currentBoards.map((currentBoard) =>
              currentBoard.id === response.board.id ? response.board : currentBoard,
            ),
          )
          setView(formReturnView)
          setFormKind(null)
          setFormInitialKey(null)
          setSelectedIndex(0)
          setNotice({
            kind: "status",
            message: `Board renamed to "${response.board.name}".`,
          })
          setFormPending(false)
        })
        void loadBoards(boardFilterRef.current, false)
      } catch (error) {
        flushSync(() => {
          setNotice({ kind: "error", message: formatBoardError(error) })
          setFormPending(false)
        })
      }
      return
    }

    if (formKind === "create-board" && boardClient) {
      flushSync(() => setFormPending(true))
      try {
        const credential = await credentialStore.load()
        if (!credential) {
          throw new Error("No active Terminal Session. Sign in to continue.")
        }
        const response = await boardClient.createBoard(credential, { name: values.name })
        flushSync(() => {
          setView(formReturnView)
          setFormKind(null)
          setFormInitialKey(null)
          setSelectedIndex(0)
          setSelectedBoardIndex(0)
          setBoardFilter("")
          setBoards((currentBoards) => [
            response.board,
            ...currentBoards.filter((currentBoard) => currentBoard.id !== response.board.id),
          ])
          setBoardCodeNotice({ kind: "initial", code: response.joinCode })
          setNotice({
            kind: "status",
            message: `Board "${response.board.name}" created.`,
          })
          setFormPending(false)
        })
        void loadBoards("", false)
      } catch (error) {
        flushSync(() => {
          setNotice({ kind: "error", message: formatBoardError(error) })
          setFormPending(false)
        })
      }
      return
    }

    if (formKind === "join-board" && boardClient) {
      flushSync(() => setFormPending(true))
      try {
        const credential = await credentialStore.load()
        if (!credential) {
          throw new Error("No active Terminal Session. Sign in to continue.")
        }
        const response = await boardClient.joinBoard(credential, { joinCode: values.joinCode })
        flushSync(() => {
          setView(formReturnView)
          setFormKind(null)
          setFormInitialKey(null)
          setSelectedIndex(0)
          setSelectedBoardIndex(0)
          setBoardFilter("")
          setBoards((currentBoards) => [
            response.board,
            ...currentBoards.filter((currentBoard) => currentBoard.id !== response.board.id),
          ])
          setBoardCodeNotice(null)
          setNotice({
            kind: "status",
            message: `Board "${response.board.name}" joined.`,
          })
          setFormPending(false)
        })
        void loadBoards("", false)
      } catch (error) {
        flushSync(() => {
          setNotice({ kind: "error", message: formatBoardError(error) })
          setFormPending(false)
        })
      }
      return
    }

    if (formKind === "filter-boards" && boardClient) {
      const filter = values.filter?.trim() ?? ""
      flushSync(() => {
        setView(formReturnView)
        setFormKind(null)
        setFormInitialKey(null)
        setSelectedIndex(0)
        setBoardFilter(filter)
        setBoardCodeNotice(null)
        setNotice(null)
        setFormPending(false)
      })
      void loadBoards(filter)
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
    if (
      sessionStateRef.current === "checking" ||
      signOutPendingRef.current ||
      boardActionPendingRef.current
    ) {
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
      if (key.name === "down") {
        moveSelection(1)
        return
      }
      if (key.name === "[" || key.name === "]") {
        moveBoardSelection(key.name === "[" ? -1 : 1)
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
      if (key.name === "f") {
        openForm("filter-boards", "boards", key.name)
        return
      }
      if (key.name === "a") {
        openView("board-actions")
        return
      }
      if (key.name === "o") {
        void openSelectedBoard()
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
        void openSelectedBoard()
        return
      }
    }

    if (viewRef.current === "canvas") {
      if (colorPickerStickyNoteIdRef.current) {
        if (key.name === "escape") {
          closeStickyNoteColorPicker()
          flushSync(() => setNotice({ kind: "status", message: "Color selection cancelled." }))
          return
        }
        const choice = stickyNoteColorChoices.find((entry) => entry.key === key.name)
        if (choice) {
          recolorSelectedStickyNote(choice.color)
        }
        return
      }
      if (!sharedBoardMutationsEnabled()) {
        if (key.name === "escape") {
          openView("boards")
          return
        }
        if (key.name === "?") {
          flushSync(() => setOverlay("help"))
          return
        }
        if (key.name === "q") {
          renderer.destroy()
        }
        return
      }
      if (modeRef.current === "navigate") {
        if (key.name === "n") {
          startProvisionalStickyNote()
          return
        }
        if (key.name === "tab") {
          key.preventDefault()
          cycleSelectedStickyNote()
          return
        }
        if (key.name === "c") {
          openStickyNoteColorPicker()
          return
        }
        if (key.name === "[" || key.name === "]") {
          key.preventDefault()
          reorderSelectedStickyNote(key.name === "[" ? "lower" : "raise")
          return
        }
        const direction = canvasDirectionForKey(key.name)
        if (
          direction &&
          key.shift &&
          !key.ctrl &&
          !key.meta &&
          !key.option &&
          !key.super &&
          !key.hyper
        ) {
          key.preventDefault()
          moveSelectedStickyNote(direction)
          return
        }
        if (
          direction &&
          !key.shift &&
          !key.meta &&
          !key.option &&
          !key.super &&
          !key.hyper
        ) {
          key.preventDefault()
          updateCanvasNavigation(direction, key.ctrl)
          return
        }
        if (key.name === "return") {
          startEstablishedStickyNoteEdit()
          return
        }
        if (key.name === "escape") {
          openView("boards")
          return
        }
      }
      if (modeRef.current === "edit" && key.name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        if (provisionalStickyNoteRef.current) {
          releaseProvisionalStickyNote()
        } else if (establishedStickyNoteEditRef.current) {
          releaseEstablishedStickyNoteEdit()
        } else {
          flushSync(() => setMode("navigate"))
        }
        return
      }
      if (
        modeRef.current === "edit" &&
        (provisionalStickyNoteRef.current || establishedStickyNoteEditRef.current)
      ) {
        if (key.name === "backspace") {
          key.preventDefault()
          const activeText = provisionalStickyNoteRef.current?.text ??
            establishedStickyNoteEditRef.current?.text ?? ""
          let graphemes: string[]
          try {
            graphemes = splitUserPerceivedCharacters(activeText)
          } catch {
            flushSync(() => setNotice({
              kind: "error",
              message: USER_PERCEIVED_CHARACTER_SEGMENTATION_UNAVAILABLE,
            }))
            return
          }
          handleActiveStickyNoteTextChange(graphemes.slice(0, -1).join(""))
          return
        }
        if (key.name === "return" || key.name === "kpenter" || key.name === "linefeed") {
          if (!key.meta && !key.ctrl && !key.super) {
            key.preventDefault()
            appendActiveStickyNoteText("\n")
            return
          }
        }
        if (
          !key.ctrl &&
          !key.meta &&
          !key.super &&
          !key.hyper &&
          key.sequence.length > 0 &&
          [...key.sequence].every((character) => character >= " " && character !== "\u007f")
        ) {
          key.preventDefault()
          appendActiveStickyNoteText(key.sequence)
          return
        }
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
      if (key.name === "r" || (key.name === "return" && selectedIndexRef.current === 2)) {
        openForm("rename-board", "board-actions", key.name)
        return
      }
      if (key.name === "t" || (key.name === "return" && selectedIndexRef.current === 3)) {
        void rotateSelectedJoinCode()
        return
      }
      if (key.name === "d" || (key.name === "return" && selectedIndexRef.current === 0)) {
        openConfirmation("board-actions")
        return
      }
      if (key.name === "l" || (key.name === "return" && selectedIndexRef.current === 1)) {
        openLeaveConfirmation()
        return
      }
    }

    if (viewRef.current === "confirmation") {
      if (key.name === "y") {
        if (confirmationActionRef.current === "leave") {
          void leaveSelectedBoard()
        } else {
          resolveConfirmation(true)
        }
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

  usePaste((event) => {
    if (
      sessionStateRef.current === "checking" ||
      signOutPendingRef.current ||
      boardActionPendingRef.current ||
      viewRef.current !== "canvas" ||
      modeRef.current !== "edit" ||
      !sharedBoardMutationsEnabled() ||
      (!provisionalStickyNoteRef.current && !establishedStickyNoteEditRef.current)
    ) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    appendActiveStickyNoteText(decodePasteBytes(event.bytes))
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
      selectedBoard={boards[selectedBoardIndex]}
      status={notice?.kind === "status" ? notice.message : "choose an action"}
      error={notice?.kind === "error" ? notice.message : undefined}
    />
  ) : view === "confirmation" ? (
    <ShellConfirmation action={confirmationAction} />
  ) : view === "canvas" ? (
    <CanvasSurface
      mode={mode}
      snapshot={boardSnapshot}
      connectionState={boardConnectionState}
      pending={boardOpenPending}
      error={notice?.kind === "error" ? notice.message : undefined}
      status={notice?.kind === "status" ? notice.message : undefined}
      cursor={canvasCursor}
      viewport={canvasViewport}
      viewportSize={canvasViewportSize}
      panelWidth={getCanvasPanelWidth(width)}
      selectedStickyNoteId={selectedStickyNoteId ?? stickyNotesAtCanvasCursor(
        boardSnapshot?.stickyNotes ?? [],
        canvasCursor,
      )[0]?.id ?? null}
      colorPickerNote={colorPickerStickyNoteId
        ? boardSnapshot?.stickyNotes?.find((note) => note.id === colorPickerStickyNoteId) ?? null
        : null}
      provisionalStickyNote={provisionalStickyNote}
      establishedStickyNoteEdit={establishedStickyNoteEdit}
      onProvisionalTextChange={handleProvisionalStickyNoteTextChange}
      onEstablishedTextChange={handleEstablishedStickyNoteTextChange}
    />
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
    <BoardList
      selectedIndex={selectedIndex}
      boards={boards}
      selectedBoardIndex={selectedBoardIndex}
      filter={boardFilter}
      pending={boardsPending}
      notice={notice}
      joinCode={boardCodeNotice}
      hasBoardClient={Boolean(boardClient)}
      sessionState={sessionState}
    />
  )
  const footerHint =
    overlay === "help"
      ? "Escape close"
      : view === "form"
        ? "Tab fields · Enter submit · Escape cancel"
        : view === "confirmation"
          ? "y confirm · n cancel · Escape cancel"
          : view === "canvas"
            ? colorPickerStickyNoteId
              ? "1-8 choose Color · Escape cancel"
              : mode === "edit"
                ? "? help · q quit · Escape leave Edit mode"
                : "? help · q quit · c Color picker · Escape back"
          : view === "boards"
            ? "f filter · c create · Escape back"
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
  const colorMode = getTerminalColorMode(capabilities)
  const capabilityLabel = colorMode === "truecolor"
    ? "Unicode · 256-color baseline active · truecolor detected"
    : colorMode === "ansi256"
      ? "Unicode · 256-color baseline active"
      : "Unicode · color capability pending"

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

function BoardList({
  selectedIndex,
  boards,
  selectedBoardIndex,
  filter,
  pending,
  notice,
  joinCode,
  hasBoardClient,
  sessionState,
}: {
  selectedIndex: number
  boards: BoardSummary[]
  selectedBoardIndex: number
  filter: string
  pending: boolean
  notice: ShellNotice | null
  joinCode: BoardCodeNotice | null
  hasBoardClient: boolean
  sessionState: SessionState
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
          width: 72,
          border: true,
          borderStyle: "rounded",
          borderColor: colors.border,
          backgroundColor: colors.panel,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.text}>Board list</text>
        <text fg={colors.muted}>
          {hasBoardClient
            ? "Every Membership appears here; Owner marks the governing Member."
            : "Memberships will appear here when the Board workflow is connected."}
        </text>
        <text fg={colors.accent}>Filter: {filter || "all Boards"}</text>
        {pending ? <text fg={colors.muted}>Loading Memberships…</text> : null}
        {!pending && hasBoardClient && sessionState !== "signed-in" ? (
          <text fg={colors.warning}>Sign in to load Memberships.</text>
        ) : null}
        {!pending && hasBoardClient && sessionState === "signed-in" && boards.length === 0 ? (
          <text fg={colors.muted}>No Memberships match this filter.</text>
        ) : null}
        {boards.map((board, index) => (
          <text key={board.id} fg={colors.text}>
            {index === selectedBoardIndex ? "›" : " "} {board.name} · {board.role === "owner" ? "Owner" : "Member"}
          </text>
        ))}
        {joinCode ? (
          <text fg={colors.success}>
            {joinCode.kind === "initial" ? "Initial" : "Rotated"} Join Code (shown once): {joinCode.code}
          </text>
        ) : null}
        {boardMenu.map((item, index) => (
          <text key={item.key} fg={index === selectedIndex ? colors.accent : colors.text}>
            {index === selectedIndex ? "›" : " "} {item.key} {item.label}
          </text>
        ))}
        <text fg={colors.muted}>[/] select Board · f filter Board name · ↑↓ / jk move · Enter choose · Escape back</text>
        {notice?.kind === "error" ? <text fg={colors.error}>Error: {notice.message}</text> : null}
        {notice?.kind === "status" ? <text fg={colors.success}>Status: {notice.message}</text> : null}
      </box>
    </box>
  )
}

function BoardActions({
  selectedIndex,
  selectedBoard,
  status,
  error,
}: {
  selectedIndex: number
  selectedBoard: BoardSummary | undefined
  status: string
  error?: string
}) {
  return (
    <ShellMenu
      title="Board actions"
      description={
        selectedBoard
          ? `Selected Board: ${selectedBoard.name} · ${selectedBoard.role === "owner" ? "Owner" : "Member"}`
          : "No Board selected. Return to choose a Membership."
      }
      items={boardActionsMenu}
      selectedIndex={selectedIndex}
      status={status}
      error={error}
    />
  )
}

function ShellConfirmation({ action }: { action: ConfirmationAction }) {
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
        <text fg={colors.warning}>{action === "leave" ? "Confirm leaving Board" : "Confirm Board action"}</text>
        <text fg={colors.text}>This action changes shared Board state.</text>
        <text fg={colors.muted}>Review the action before continuing.</text>
        <text fg={colors.warning}>y confirm · n cancel · Escape cancel</text>
      </box>
    </box>
  )
}

function CanvasSurface({
  mode,
  snapshot,
  connectionState,
  pending,
  error,
  status,
  cursor,
  viewport,
  viewportSize,
  panelWidth,
  selectedStickyNoteId,
  colorPickerNote,
  provisionalStickyNote,
  establishedStickyNoteEdit,
  onProvisionalTextChange,
  onEstablishedTextChange,
}: {
  mode: ShellMode
  snapshot: BoardSnapshot | null
  connectionState: BoardConnectionState | null
  pending: boolean
  error?: string
  status?: string
  cursor: StickyNotePosition
  viewport: StickyNotePosition
  viewportSize: CanvasViewportSize
  panelWidth: number
  selectedStickyNoteId: string | null
  colorPickerNote: StickyNote | null
  provisionalStickyNote: ProvisionalStickyNote | null
  establishedStickyNoteEdit: EstablishedStickyNoteEdit | null
  onProvisionalTextChange(text: string): boolean
  onEstablishedTextChange(text: string): boolean
}) {
  const notes = snapshot?.stickyNotes ?? []
  const selectedNote = selectedStickyNoteId
    ? notes.find((note) => note.id === selectedStickyNoteId)
    : undefined
  const overlappingNotes = stickyNotesAtCanvasCursor(notes, cursor)
  const overlapSelectionIndex = selectedNote
    ? overlappingNotes.findIndex((note) => note.id === selectedNote.id)
    : -1
  const selectedNoteText = establishedStickyNoteEdit && selectedNote &&
    establishedStickyNoteEdit.stickyNoteId === selectedNote.id
    ? establishedStickyNoteEdit.text
    : selectedNote?.text
  const statusBeforeCanvas = status?.includes("Stacking Order") || status?.includes("Position") || false
  const visibleNotes = sortCanvasStackingOrder(
    notes.filter((note) => canvasRectIntersectsViewport(
      stickyNoteCanvasFootprint(note),
      viewport,
      viewportSize,
    )),
  )

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
          width: panelWidth,
          border: true,
          borderStyle: "rounded",
          borderColor: mode === "navigate" ? colors.accent : colors.warning,
          backgroundColor: colors.panel,
          padding: 1,
          flexDirection: "column",
        }}
      >
        <text fg={colors.text}>Board canvas</text>
        {connectionState === "waking" ? (
          <>
            <text fg={colors.warning}>Connection: WAKING</text>
            <text fg={colors.muted}>Render or hosted PostgreSQL is waking up.</text>
            <text fg={colors.warning}>Retrying with bounded backoff; shared mutations disabled.</text>
            {error ? <text fg={colors.error}>Error: {error}</text> : null}
          </>
        ) : connectionState === "reconnecting" ? (
          <>
            <text fg={colors.warning}>Connection: RECONNECTING</text>
            <text fg={colors.muted}>No offline Board state is retained.</text>
            <text fg={colors.warning}>Shared mutations disabled until a fresh snapshot arrives.</text>
            {error ? <text fg={colors.error}>Error: {error}</text> : null}
          </>
        ) : connectionState === "unavailable" ? (
          <>
            <text fg={colors.error}>Connection: UNAVAILABLE</text>
            <text fg={colors.muted}>The Tuiscrib Service is unavailable.</text>
            <text fg={colors.warning}>Retrying with bounded backoff; shared mutations disabled.</text>
            {error ? <text fg={colors.error}>Error: {error}</text> : null}
          </>
        ) : connectionState === "unauthorized" ? (
          <>
            <text fg={colors.error}>Connection: UNAUTHORIZED</text>
            <text fg={colors.muted}>This Terminal Session is unauthorized.</text>
            <text fg={colors.warning}>Sign in again; shared mutations disabled.</text>
            {error ? <text fg={colors.error}>Error: {error}</text> : null}
          </>
        ) : connectionState === "closed" ? (
          <>
            <text fg={colors.error}>Connection: CLOSED</text>
            <text fg={colors.muted}>Board collaboration is no longer available.</text>
            <text fg={colors.warning}>Shared mutations disabled.</text>
            {error ? <text fg={colors.error}>Error: {error}</text> : null}
          </>
        ) : connectionState === "connecting" || pending ? (
          <>
            <text fg={colors.accent}>Opening Board over WebSocket…</text>
            <text fg={colors.muted}>Loading one authoritative snapshot.</text>
          </>
        ) : error && !snapshot ? (
          <text fg={colors.error}>Error: {error}</text>
        ) : snapshot ? (
          <>
            <text fg={colors.success}>
              Board revision: {snapshot.revision} · Connection: CONNECTED · Board: {snapshot.board.name}
            </text>
            <text fg={colors.muted}>
              Canvas cursor: ({cursor.x}, {cursor.y}) · Viewport origin: ({viewport.x}, {viewport.y}) · visible {viewportSize.width}×{viewportSize.height}
            </text>
            <text fg={colors.text}>
              Selected Sticky Note: {selectedNoteText ?? "none"}{selectedNote ? ` · Stacking Order ${selectedNote.stackingOrder}` : ""}
            </text>
            {overlappingNotes.length > 1 ? (
              <>
                <text fg={colors.accent}>
                  Overlap selection: {overlapSelectionIndex >= 0 ? overlapSelectionIndex + 1 : "—"}/{overlappingNotes.length} · Tab cycles front-to-back
                </text>
                <text fg={colors.muted}>
                  Stacking Order back-to-front: {sortCanvasStackingOrder(overlappingNotes, "back-to-front")
                    .map((note) => `${note.text} (${note.stackingOrder})`)
                    .join(" · ")}
                </text>
              </>
            ) : null}
            <text fg={colors.text}>Viewing Presence</text>
            {snapshot.presence.map((presence) => (
              <text key={presence.member.username} fg={colors.muted}>
                {presence.member.username} · {presence.activity}
              </text>
            ))}
            {(snapshot.editClaims ?? []).some((claim) => claim.status === "disconnected") ? (
              <>
                <text fg={colors.text}>Edit Claims</text>
                {(snapshot.editClaims ?? []).filter((claim) => claim.status === "disconnected").map((claim) => (
                  <text key={claim.stickyNoteId} fg={claim.status === "disconnected" ? colors.warning : colors.muted}>
                    Edit Claim · {claim.stickyNoteId} · {claim.holder.username} · {claim.status === "disconnected"
                      ? "disconnected · grace active"
                      : "connected"}
                  </text>
                ))}
              </>
            ) : null}
            <text fg={colors.accent}>
              Sticky Notes: {snapshot.stickyNotes?.length ?? 0} · {mode === "navigate"
                ? selectedStickyNoteId
                  ? "Navigate mode · Sticky Note selected"
                  : cursor.x === 0 && cursor.y === 0
                    ? "Navigate mode · cursor at the stable origin"
                    : `Navigate mode · cursor at (${cursor.x}, ${cursor.y})`
                : `Edit mode · ${provisionalStickyNote ? "creation text editing active" : "established text editing active"}`}
                {mode === "edit" && establishedStickyNoteEdit
                  ? ` · Claim ${establishedStickyNoteEdit.status}`
                  : ""}
            </text>
            {selectedNote ? (
              <text fg={colors.muted}>
                Color {selectedNote.color} · Authored by {selectedNote.authorship.member.username} · Last edit by {selectedNote.lastEdit.member.username}
              </text>
            ) : null}
            {error && snapshot ? <text fg={colors.error}>Error: {error}</text> : null}
            {colorPickerNote ? <StickyNoteColorPicker note={colorPickerNote} /> : null}
            {statusBeforeCanvas ? <text fg={colors.success}>Status: {status}</text> : null}
            <box
              style={{
                width: viewportSize.width,
                height: viewportSize.height,
                backgroundColor: colors.background,
                position: "relative",
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              {visibleNotes.map((note) => {
                const screen = canvasCoordinateToScreen(note.position, viewport)
                const left = screen.x
                const top = screen.y
                return establishedStickyNoteEdit?.stickyNoteId === note.id && mode === "edit" ? (
                  <EstablishedStickyNoteEditorCard
                    key={note.id}
                    note={note}
                    draft={establishedStickyNoteEdit}
                    left={left}
                    top={top}
                    onTextChange={onEstablishedTextChange}
                  />
                ) : (
                  <StickyNoteCard
                    key={note.id}
                    note={note}
                    selected={note.id === selectedStickyNoteId}
                    left={left}
                    top={top}
                  />
                )
              })}
              {cursor.x >= viewport.x &&
                cursor.x < viewport.x + viewportSize.width &&
                cursor.y >= viewport.y &&
                cursor.y < viewport.y + viewportSize.height ? (() => {
                  const screen = canvasCoordinateToScreen(cursor, viewport)
                  return (
                    <text
                      style={{
                        position: "absolute",
                        left: screen.x,
                        top: screen.y,
                        zIndex: 1_000,
                      }}
                      fg={colors.accent}
                    >
                      +
                    </text>
                  )
                })() : null}
            </box>
            {provisionalStickyNote ? (
              <box
                style={{
                  width: 40,
                  border: true,
                  borderStyle: "rounded",
                  borderColor: colors.warning,
                  backgroundColor: colors.panelStrong,
                  padding: 1,
                  flexDirection: "column",
                }}
              >
                <text fg={colors.warning}>
                  Provisional Sticky Note · {provisionalStickyNote.status === "requesting"
                    ? "authority pending"
                    : provisionalStickyNote.status === "granted"
                      ? "authority granted"
                      : "durable"}
                </text>
                <text fg={colors.muted}>
                  Position ({provisionalStickyNote.position.x}, {provisionalStickyNote.position.y}) · Color {provisionalStickyNote.color}
                </text>
                <text fg={colors.muted}>
                  Draft characters: {userPerceivedCharacterCountLabel(provisionalStickyNote.text)}
                </text>
                <StickyNoteEditor
                  draft={{
                    editorId: provisionalStickyNote.provisionalId,
                    text: provisionalStickyNote.text,
                    status: provisionalStickyNote.status,
                  }}
                  mode={mode}
                  onTextChange={onProvisionalTextChange}
                />
              </box>
            ) : null}
            {!statusBeforeCanvas && status ? <text fg={colors.success}>Status: {status}</text> : null}
          </>
        ) : mode === "navigate" ? (
          <>
            <text fg={colors.accent}>
              {cursor.x === 0 && cursor.y === 0
                ? "Navigate mode · cursor at the stable origin"
                : `Navigate mode · cursor at (${cursor.x}, ${cursor.y})`}
            </text>
            <text fg={colors.muted}>Enter edit · Tab cycle overlap · [ lower · ] raise · c Color · arrows / hjkl move cursor · Shift+arrows / Shift+hjkl move Sticky Note</text>
          </>
        ) : (
          <>
            <text fg={colors.warning}>Edit mode · keyboard text editing active</text>
            <text fg={colors.muted}>Escape leave Edit mode · n creates a durable Sticky Note</text>
          </>
        )}
      </box>
    </box>
  )
}

function canvasDirectionForKey(name: string): CanvasDirection | undefined {
  switch (name) {
    case "left":
    case "h":
    case "H":
      return "left"
    case "right":
    case "l":
    case "L":
      return "right"
    case "up":
    case "k":
    case "K":
      return "up"
    case "down":
    case "j":
    case "J":
      return "down"
    default:
      return undefined
  }
}

function userPerceivedCharacterCountLabel(value: string): string {
  try {
    return String(countUserPerceivedCharacters(value))
  } catch {
    return "unavailable"
  }
}

function EstablishedStickyNoteEditorCard({
  note,
  draft,
  left,
  top,
  onTextChange,
}: {
  note: StickyNote
  draft: EstablishedStickyNoteEdit
  left?: number
  top?: number
  onTextChange(text: string): boolean
}) {
  const positioned = left !== undefined && top !== undefined
  return (
    <box
      style={{
        width: CANVAS_STICKY_NOTE_CARD_WIDTH,
        ...(positioned ? { position: "absolute" as const, left, top, zIndex: note.stackingOrder + 1 } : {}),
        border: true,
        borderStyle: "rounded",
        borderColor: colors.warning,
        backgroundColor: colors.panelStrong,
        padding: 1,
        flexDirection: "column",
      }}
    >
      <text fg={colors.warning}>Established Sticky Note · Edit Claim {draft.status}</text>
      <text fg={colors.muted}>
        Position ({note.position.x}, {note.position.y}) · v{draft.textVersion} · Color {note.color}
      </text>
      <StickyNoteEditor
        draft={{ editorId: draft.stickyNoteId, text: draft.text, status: draft.status }}
        mode="edit"
        ignoreInitialShortcutInput={false}
        ignoreInitialContentChange
        onTextChange={onTextChange}
      />
      <text fg={colors.muted}>Authored by {note.authorship.member.username} · {note.createdAt}</text>
      <text fg={colors.muted}>Last edit by {note.lastEdit.member.username} · {note.lastEdit.at}</text>
    </box>
  )
}

function StickyNoteEditor({
  draft,
  mode,
  ignoreInitialShortcutInput = true,
  ignoreInitialContentChange = false,
  onTextChange,
}: {
  draft: StickyNoteEditorDraft
  mode: ShellMode
  ignoreInitialShortcutInput?: boolean
  ignoreInitialContentChange?: boolean
  onTextChange(text: string): boolean
}) {
  const textareaRef = useRef<TextareaRenderable | null>(null)
  const ignoreShortcutInputRef = useRef(ignoreInitialShortcutInput)
  const ignoreInitialContentChangeRef = useRef(ignoreInitialContentChange)
  const syncingTextRef = useRef(false)
  const [text, setText] = useState(draft.text)
  const textRef = useRef(draft.text)
  const lines = wrapStickyNoteText(text)

  useEffect(() => {
    if (draft.text !== textRef.current) {
      textRef.current = draft.text
      setText(draft.text)
      if (textareaRef.current) {
        syncingTextRef.current = true
        textareaRef.current.setText(draft.text)
        syncingTextRef.current = false
      }
    }
  }, [draft.text])

  useLayoutEffect(() => {
    if (draft.text === textRef.current && textareaRef.current?.plainText !== draft.text) {
      syncingTextRef.current = true
      textareaRef.current?.setText(draft.text)
      syncingTextRef.current = false
    }
    if (mode === "edit") {
      textareaRef.current?.focus()
    }
    ignoreShortcutInputRef.current = ignoreInitialShortcutInput
  }, [draft.editorId, draft.status, mode, ignoreInitialShortcutInput])

  useLayoutEffect(() => {
    ignoreInitialContentChangeRef.current = ignoreInitialContentChange
  }, [draft.editorId, draft.status, ignoreInitialContentChange])

  const handleContentChange = () => {
    const nextText = textareaRef.current?.plainText ?? ""
    if (syncingTextRef.current) {
      return
    }
    if (ignoreInitialContentChangeRef.current) {
      ignoreInitialContentChangeRef.current = false
      if (nextText !== draft.text) {
        syncingTextRef.current = true
        textareaRef.current?.setText(draft.text)
        syncingTextRef.current = false
        textRef.current = draft.text
        setText(draft.text)
      }
      return
    }
    if (ignoreShortcutInputRef.current && nextText === "n") {
      ignoreShortcutInputRef.current = false
      textareaRef.current?.setText("")
      textRef.current = ""
      setText("")
      onTextChange("")
      return
    }
    ignoreShortcutInputRef.current = false
    const previousText = textRef.current
    if (!onTextChange(nextText)) {
      syncingTextRef.current = true
      textareaRef.current?.setText(previousText)
      syncingTextRef.current = false
      setText(previousText)
      return
    }
    textRef.current = nextText
    setText(nextText)
  }

  return (
    <>
      <textarea
        ref={(textarea) => {
          textareaRef.current = textarea
        }}
        focused={mode === "edit"}
        width={32}
        height={Math.max(3, lines.length + 2)}
        initialValue={draft.text}
        placeholder="Type a Sticky Note…"
        placeholderColor={colors.muted}
        wrapMode="char"
        backgroundColor={colors.panel}
        focusedBackgroundColor="#26374d"
        textColor={colors.text}
        focusedTextColor={colors.text}
        cursorColor={colors.accent}
        onContentChange={handleContentChange}
      />
      <text fg={colors.muted}>
        {lines.length} wrapped line{lines.length === 1 ? "" : "s"} · publishes after idle
      </text>
    </>
  )
}

function StickyNoteCard({
  note,
  selected = false,
  left,
  top,
}: {
  note: StickyNote
  selected?: boolean
  left?: number
  top?: number
}) {
  const lines = wrapStickyNoteText(note.text)
  const positioned = left !== undefined && top !== undefined
  return (
    <box
      style={{
        width: CANVAS_STICKY_NOTE_CARD_WIDTH,
        ...(positioned ? { position: "absolute" as const, left, top, zIndex: note.stackingOrder + 1 } : {}),
        border: true,
        borderStyle: "rounded",
        borderColor: selected ? colors.accent : stickyNoteColor(note.color),
        backgroundColor: colors.panelStrong,
        padding: 1,
        flexDirection: "column",
      }}
    >
      <text fg={stickyNoteColor(note.color)}>
        {selected ? "› " : "  "}Sticky Note · ({note.position.x}, {note.position.y}) · v{note.textVersion} · Color {note.color}
      </text>
      {lines.map((line, index) => (
        <text key={`${note.id}-line-${index}`} fg={colors.text}>{line || " "}</text>
      ))}
      <text fg={colors.muted}>Authored by {note.authorship.member.username} · {note.createdAt}</text>
      <text fg={colors.muted}>Last edit by {note.lastEdit.member.username} · {note.lastEdit.at}</text>
    </box>
  )
}

function StickyNoteColorPicker({ note }: { note: StickyNote }) {
  return (
    <box
      style={{
        width: 42,
        border: true,
        borderStyle: "rounded",
        borderColor: colors.warning,
        backgroundColor: colors.panelStrong,
        padding: 1,
        flexDirection: "column",
      }}
    >
      <text fg={colors.warning}>Color picker · Sticky Note</text>
      <text fg={colors.muted}>Color carries no workflow meaning.</text>
      <text fg={colors.text}>Current: {note.color}</text>
      {stickyNoteColorChoices.slice(0, 4).map((choice, index) => {
        const pairedChoice = stickyNoteColorChoices[index + 4]
        return (
          <text key={choice.key} fg={stickyNoteColor(choice.color)}>
            {choice.key} {choice.color}{choice.color === note.color ? " (current)" : ""}   {pairedChoice.key} {pairedChoice.color}{pairedChoice.color === note.color ? " (current)" : ""}
          </text>
        )
      })}
      <text fg={colors.muted}>Choose 1-8 · Escape cancel</text>
    </box>
  )
}

function stickyNoteColor(color: StickyNoteColor): string {
  switch (color) {
    case "amber":
    case "yellow":
      return colors.warning
    case "green":
      return colors.success
    case "red":
      return colors.error
    case "blue":
    case "cyan":
    case "magenta":
    case "violet":
      return colors.accent
  }
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
  const [inputError, setInputError] = useState<string | null>(null)
  const focusedIndexRef = useRef(focusedIndex)
  const valuesRef = useRef(values)
  const inputRefs = useRef<Array<InputRenderable | null>>([])
  const initialKeyToIgnoreRef = useRef(initialKeyToIgnore)
  const secretValuesRef = useRef<Record<string, string>>({})
  const displayedSecretValuesRef = useRef<Record<string, string>>({})
  const maskingInputRef = useRef(false)
  focusedIndexRef.current = focusedIndex
  valuesRef.current = values

  useLayoutEffect(() => {
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
                if (initialKeyToIgnoreRef.current && value === initialKeyToIgnoreRef.current) {
                  const input = inputRefs.current[index]
                  if (input) {
                    input.value = ""
                  }
                  initialKeyToIgnoreRef.current = null
                  return
                }

                if (field.sensitive) {
                  if (maskingInputRef.current) {
                    return
                  }

                  const previousRawValue = secretValuesRef.current[field.id] ?? ""
                  const previousDisplayedValue = displayedSecretValuesRef.current[field.id] ?? ""
                  let nextRawValue: string
                  let nextDisplayedValue: string
                  try {
                    nextRawValue = updateMaskedInputValue(
                      previousRawValue,
                      previousDisplayedValue,
                      value,
                    )
                    nextDisplayedValue = "•".repeat(
                      countUserPerceivedCharacters(nextRawValue),
                    )
                  } catch {
                    setInputError(USER_PERCEIVED_CHARACTER_SEGMENTATION_UNAVAILABLE)
                    return
                  }
                  setInputError(null)
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

                setInputError(null)
                const nextValues = { ...valuesRef.current, [field.id]: value }
                valuesRef.current = nextValues
                setValues(nextValues)
              }}
              onSubmit={() => onSubmit(valuesRef.current)}
            />
          </box>
        ))}
        {pending ? <text fg={colors.muted}>Contacting the Tuiscrib Service…</text> : null}
        {inputError ? <text fg={colors.error}>Error: {inputError}</text> : null}
        {notice?.kind === "error" ? <text fg={colors.error}>Error: {notice.message}</text> : null}
        <text fg={colors.muted}>Tab next field · Enter submit · Escape cancel</text>
      </box>
    </box>
  )
}

function formatBoardError(error: unknown): string {
  if (error instanceof CredentialStoreError) {
    return formatCredentialStoreError(error)
  }
  if (error instanceof ServiceRequestError) {
    const fieldErrors = Object.values(error.details.fieldErrors ?? {})
    return fieldErrors.length > 0
      ? `${error.details.error} ${fieldErrors.join(" ")}`
      : error.details.error
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  return "Service unavailable. Try again later."
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
        <text fg={colors.muted}>Boards: o open · c create · f filter · j join · a actions</text>
        <text fg={colors.muted}>Owner actions: r rename · t rotate Join Code</text>
        <text fg={colors.muted}>Forms: Tab next field · Enter submit · Escape cancel</text>
        <text fg={colors.muted}>Confirmations: y confirm · n cancel</text>
        <text fg={colors.muted}>↑↓ / jk move · Enter choose · Escape back</text>
        <text fg={colors.muted}>Canvas: Tab cycle overlap · [ lower · ] raise · c Color picker · Shift+arrows / Shift+hjkl move Sticky Note · 1-8 choose</text>
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
