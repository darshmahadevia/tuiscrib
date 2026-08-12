import {
  createTextAttributes,
  type InputRenderable,
  type TerminalCapabilities,
  type TextareaRenderable,
} from "@opentui/core"
import { flushSync, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
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
  CANVAS_MAX_COORDINATE,
  CANVAS_MIN_COORDINATE,
  canvasCoordinateToScreen,
  canvasPointIsInsideRect,
  canvasRectIntersectsViewport,
  createCanvasNavigationState,
  getCanvasStickyNoteCardRect,
  getCanvasViewportSize,
  CANVAS_STICKY_NOTE_CARD_WIDTH,
  CANVAS_STICKY_NOTE_CARD_HEIGHT,
  nearestCanvasNote,
  selectCanvasNoteInDirection,
  sortCanvasStackingOrder,
  type CanvasDirection,
  type CanvasViewportSize,
} from "./canvas-navigation.ts"

export const MIN_TERMINAL_WIDTH = 80
export const MIN_TERMINAL_HEIGHT = 24

export type ShellMode = "navigate" | "select" | "edit"

export type TerminalShellProps = {
  label?: string
  capabilities?: TerminalCapabilities | null
  authClient?: AuthClient
  boardClient?: BoardClient
  credentialStore?: CredentialStore
  stickyNoteTimer?: StickyNoteTimer
}

type ShellOverlay = "none" | "help" | "actions" | "info" | "move"
type ShellView =
  | "home"
  | "boards"
  | "join-code"
  | "board-actions"
  | "board-delete-confirmation"
  | "canvas"
  | "form"
  | "confirmation"
type ConfirmationAction =
  | "placeholder"
  | "leave"
  | "delete-sticky-note"

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
  boardId: string
  boardName: string
  kind: "initial" | "rotated"
  code: string
}

type SessionState = "checking" | "signed-out" | "signed-in"

type ShellMenuItem = {
  id: string
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
  saveRequested: boolean
}

type EstablishedStickyNoteEdit = {
  stickyNoteId: string
  text: string
  textVersion: number
  status: "requesting" | "granted"
  claimId?: string
  dirty: boolean
  publicationRequested: boolean
  saveRequested: boolean
  publishedText?: string
  releaseRequested: boolean
  releaseSent: boolean
  claimRequestSent: boolean
  reconnecting: boolean
}

type StickyNoteDeletion = {
  stickyNoteId: string
  note: StickyNote
  status: "requesting" | "confirming" | "deleting"
  claimId?: string
}

type StickyNoteEditorDraft = {
  editorId: string
  text: string
  status: string
}

type CanvasAction = "add" | "info" | "edit" | "move" | "delete" | "navigate" | "select" | "help"

type MovingStickyNote = {
  stickyNoteId: string
  original: StickyNotePosition
  position: StickyNotePosition
}

const homeMenu: ShellMenuItem[] = [
  { id: "boards", label: "boards", description: "Open the Board list" },
  { id: "sign-in", label: "sign in", description: "Sign in as a User" },
  { id: "register", label: "register", description: "Register a new User" },
  { id: "sign-out", label: "sign out", description: "Revoke the current Terminal Session" },
]

const boardMenu: ShellMenuItem[] = [
  { id: "open", label: "open Board", description: "Open the collaboration canvas" },
  { id: "create", label: "create Board", description: "Start a new Board" },
  { id: "join", label: "join Board", description: "Redeem a Join Code" },
  { id: "actions", label: "Board actions", description: "Manage the selected Board" },
]

const boardActionsMenu: ShellMenuItem[] = [
  { id: "delete", label: "delete Board", description: "Permanently remove this Board" },
  { id: "leave", label: "leave Board", description: "Leave this Board as a Member" },
  { id: "rename", label: "rename Board", description: "Rename this Board as the Owner" },
  { id: "show-code", label: "show Join Code", description: "Show the current code if it was issued in this Terminal Session" },
  { id: "rotate-code", label: "rotate Join Code", description: "Replace this Board's Join Code as the Owner" },
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
  // A blue-black world keeps the canvas quiet while giving every elevation
  // a reliable surface. Accent color is reserved for focus and wayfinding.
  background: "#000000",
  canvas: "#0b1016",
  panel: "#121a23",
  panelStrong: "#18232e",
  panelActive: "#25394d",
  stickyNote: "#506779",
  input: "#0d151d",
  border: "#304252",
  borderStrong: "#526a7f",
  text: "#edf3f7",
  muted: "#9aabb8",
  subtle: "#788b99",
  accent: "#91cdf7",
  accentStrong: "#b9e4ff",
  accentInk: "#071018",
  dangerSurface: "#39262b",
  success: "#8fd7b0",
  warning: "#edc17b",
  loading: "#c4a7ff",
  error: "#f08f99",
  overlay: "#020406",
}

// Keep the shell's resting surfaces predictable. The canvas can use the full
// terminal, while every menu/form/confirmation uses the same width and a
// deliberate fixed height for its content density.
const SHELL_PANEL_WIDTH = 72
const SHELL_MENU_PANEL_HEIGHT = 20
const SHELL_BOARD_PANEL_HEIGHT = 20
const SHELL_JOIN_CODE_PANEL_HEIGHT = 18
const SHELL_CONFIRMATION_PANEL_HEIGHT = 12
const SHELL_HELP_PANEL_HEIGHT = 16
const CANVAS_ACTION_PANEL_WIDTH = 64
const CANVAS_ACTION_PANEL_HEIGHT = 18
const CANVAS_MOVE_PANEL_WIDTH = 72
const CANVAS_MOVE_PANEL_HEIGHT = 3
const CANVAS_OVERLAY_WIDTH = 64
const CANVAS_OVERLAY_HEIGHT = 20
const menuTitleAttributes = createTextAttributes({ bold: true })

function stickyNoteCanvasFootprint(note: StickyNote) {
  return getCanvasStickyNoteCardRect(note.position)
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

function canvasViewportForStickyNote(
  position: StickyNotePosition,
  viewportSize: CanvasViewportSize,
): StickyNotePosition {
  const x = position.x - Math.floor((viewportSize.width - CANVAS_STICKY_NOTE_CARD_WIDTH) / 2)
  const y = position.y - Math.floor((viewportSize.height - CANVAS_STICKY_NOTE_CARD_HEIGHT) / 2)
  return {
    x: Math.max(
      CANVAS_MIN_COORDINATE,
      Math.min(CANVAS_MAX_COORDINATE - viewportSize.width + 1, x),
    ),
    y: Math.max(
      CANVAS_MIN_COORDINATE,
      Math.min(CANVAS_MAX_COORDINATE - viewportSize.height + 1, y),
    ),
  }
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
  const [stableMode, setStableMode] = useState<Exclude<ShellMode, "edit">>("navigate")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedBoardIndex, setSelectedBoardIndex] = useState(0)
  const [formKind, setFormKind] = useState<FormKind | null>(null)
  const [formReturnView, setFormReturnView] = useState<ShellView>("home")
  const [formInitialKey, setFormInitialKey] = useState<string | null>(null)
  const [confirmationReturnView, setConfirmationReturnView] = useState<ShellView>("boards")
  const [confirmationAction, setConfirmationAction] = useState<ConfirmationAction>("placeholder")
  const [boardDeleteInitialKey, setBoardDeleteInitialKey] = useState<string | null>(null)
  const [notice, setNotice] = useState<ShellNotice | null>(null)
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [boardFilter, setBoardFilter] = useState("")
  const [boardsPending, setBoardsPending] = useState(false)
  const [boardCodeNotice, setBoardCodeNotice] = useState<BoardCodeNotice | null>(null)
  const [knownBoardCodes, setKnownBoardCodes] = useState<Record<string, BoardCodeNotice>>({})
  const [boardSnapshot, setBoardSnapshot] = useState<BoardSnapshot | null>(null)
  const [boardConnectionState, setBoardConnectionState] = useState<BoardConnectionState | null>(null)
  const [canvasCursor, setCanvasCursor] = useState<StickyNotePosition>(
    () => createCanvasNavigationState().cursor,
  )
  const [canvasViewport, setCanvasViewport] = useState<StickyNotePosition>(
    () => createCanvasNavigationState().viewport,
  )
  const [selectedStickyNoteId, setSelectedStickyNoteId] = useState<string | null>(null)
  const [provisionalStickyNote, setProvisionalStickyNote] =
    useState<ProvisionalStickyNote | null>(null)
  const [establishedStickyNoteEdit, setEstablishedStickyNoteEdit] =
    useState<EstablishedStickyNoteEdit | null>(null)
  const [stickyNoteDeletion, setStickyNoteDeletion] = useState<StickyNoteDeletion | null>(null)
  const [actionMenuIndex, setActionMenuIndex] = useState(0)
  const [infoStickyNoteId, setInfoStickyNoteId] = useState<string | null>(null)
  const [movingStickyNote, setMovingStickyNote] = useState<MovingStickyNote | null>(null)
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
  const stableModeRef = useRef<Exclude<ShellMode, "edit">>(stableMode)
  const selectedIndexRef = useRef(selectedIndex)
  const selectedBoardIndexRef = useRef(selectedBoardIndex)
  const sessionStateRef = useRef(sessionState)
  const authenticatedUsernameRef = useRef<string | null>(authenticatedUsername)
  const boardFilterRef = useRef(boardFilter)
  const signOutPendingRef = useRef(signOutPending)
  const confirmationActionRef = useRef(confirmationAction)
  const boardActionPendingRef = useRef(boardActionPending)
  const boardCodeNoticeRef = useRef<BoardCodeNotice | null>(boardCodeNotice)
  const knownBoardCodesRef = useRef<Record<string, BoardCodeNotice>>(knownBoardCodes)
  const boardConnectionRef = useRef<BoardConnection | null>(null)
  const activeBoardIdRef = useRef<string | null>(null)
  const boardConnectionGenerationRef = useRef(0)
  const boardConnectionStateRef = useRef<BoardConnectionState | null>(boardConnectionState)
  const boardSnapshotRef = useRef<BoardSnapshot | null>(boardSnapshot)
  const canvasCursorRef = useRef(canvasCursor)
  const canvasViewportRef = useRef(canvasViewport)
  const selectedStickyNoteIdRef = useRef<string | null>(selectedStickyNoteId)
  const provisionalStickyNoteRef = useRef<ProvisionalStickyNote | null>(null)
  const establishedStickyNoteEditRef = useRef<EstablishedStickyNoteEdit | null>(
    establishedStickyNoteEdit,
  )
  const stickyNoteDeletionRef = useRef<StickyNoteDeletion | null>(stickyNoteDeletion)
  const actionMenuIndexRef = useRef(actionMenuIndex)
  const infoStickyNoteIdRef = useRef<string | null>(infoStickyNoteId)
  const movingStickyNoteRef = useRef<MovingStickyNote | null>(movingStickyNote)
  const cancelledProvisionalIdsRef = useRef(new Set<string>())
  const cancelledStickyNoteEditIdsRef = useRef(new Set<string>())
  const cancelledStickyNoteEditRequestsRef = useRef(new Set<string>())
  const cancelledStickyNoteDeletionIdsRef = useRef(new Set<string>())
  const cancelledStickyNoteDeletionRequestsRef = useRef(new Set<string>())
  const stickyNoteDebouncerRef = useRef<StickyNoteDebouncer | null>(null)
  overlayRef.current = overlay
  viewRef.current = view
  modeRef.current = mode
  stableModeRef.current = stableMode
  selectedIndexRef.current = selectedIndex
  selectedBoardIndexRef.current = selectedBoardIndex
  sessionStateRef.current = sessionState
  authenticatedUsernameRef.current = authenticatedUsername
  boardFilterRef.current = boardFilter
  signOutPendingRef.current = signOutPending
  confirmationActionRef.current = confirmationAction
  boardActionPendingRef.current = boardActionPending
  boardCodeNoticeRef.current = boardCodeNotice
  knownBoardCodesRef.current = knownBoardCodes
  boardConnectionStateRef.current = boardConnectionState
  boardSnapshotRef.current = boardSnapshot
  canvasCursorRef.current = canvasCursor
  canvasViewportRef.current = canvasViewport
  selectedStickyNoteIdRef.current = selectedStickyNoteId
  provisionalStickyNoteRef.current = provisionalStickyNote
  establishedStickyNoteEditRef.current = establishedStickyNoteEdit
  stickyNoteDeletionRef.current = stickyNoteDeletion
  actionMenuIndexRef.current = actionMenuIndex
  infoStickyNoteIdRef.current = infoStickyNoteId
  movingStickyNoteRef.current = movingStickyNote

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

  function setStableCanvasMode(next: Exclude<ShellMode, "edit">): void {
    const nextCursor = next === "navigate"
      ? {
          x: canvasViewportRef.current.x + Math.floor(canvasViewportSize.width / 2),
          y: canvasViewportRef.current.y + Math.floor(canvasViewportSize.height / 2),
        }
      : canvasCursorRef.current
    canvasCursorRef.current = nextCursor
    stableModeRef.current = next
    flushSync(() => {
      setStableMode(next)
      setMode(next)
      if (next === "navigate") {
        setCanvasCursor(nextCursor)
      }
    })
  }

  useEffect(() => {
    renderer.setBackgroundColor(colors.background)
  }, [renderer])

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
          setView("boards")
          setSelectedIndex(0)
          setNotice({
            kind: "status",
            message: `Terminal Session restored for ${response.user.username}.`,
          })
        })
        void loadBoards("")
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

  function updateStickyNoteDeletion(
    update: (current: StickyNoteDeletion | null) => StickyNoteDeletion | null,
  ) {
    const next = update(stickyNoteDeletionRef.current)
    stickyNoteDeletionRef.current = next
    flushSync(() => setStickyNoteDeletion(next))
  }

  function sharedBoardMutationsEnabled(): boolean {
    return !boardClient?.openBoard || boardConnectionStateRef.current === "connected"
  }

  function discardLocalBoardWorkAfterConnectionLoss(
    preserveEstablishedEdit = false,
  ): void {
    stickyNoteDebouncerRef.current?.cancel()
    provisionalStickyNoteRef.current = null
    const deletion = stickyNoteDeletionRef.current
    if (deletion) {
      cancelledStickyNoteDeletionIdsRef.current.add(deletion.stickyNoteId)
    }
    stickyNoteDeletionRef.current = null
    cancelledProvisionalIdsRef.current.clear()
    if (!preserveEstablishedEdit) {
      cancelledStickyNoteEditIdsRef.current.clear()
      cancelledStickyNoteEditRequestsRef.current.clear()
    }
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
    const nextMode: ShellMode = preservedEdit ? "edit" : stableModeRef.current
    modeRef.current = nextMode
    flushSync(() => {
      setProvisionalStickyNote(null)
      setEstablishedStickyNoteEdit(preservedEdit)
      setStickyNoteDeletion(null)
      setMode(nextMode)
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

    const next = { ...draft, publicationRequested: true, saveRequested: false }
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
        ? { ...current, publicationRequested: true, saveRequested: false, publishedText: text }
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
    const notes = boardSnapshotRef.current?.stickyNotes ?? []
    if (modeRef.current === "select" && !pan) {
      const next = selectCanvasNoteInDirection(
        notes,
        selectedStickyNoteIdRef.current,
        direction,
      )
      if (!next || next.id === selectedStickyNoteIdRef.current) {
        flushSync(() => setNotice({ kind: "status", message: "No Sticky Note in that direction." }))
        return
      }
      const nextViewport = canvasViewportForStickyNote(next.position, canvasViewportSize)
      const nextCursor = { ...next.position }
      selectedStickyNoteIdRef.current = next.id
      canvasCursorRef.current = nextCursor
      canvasViewportRef.current = nextViewport
      flushSync(() => {
        setSelectedStickyNoteId(next.id)
        setCanvasCursor(nextCursor)
        setCanvasViewport(nextViewport)
        setNotice(null)
      })
      return
    }

    let next = {
      cursor: canvasCursorRef.current,
      viewport: canvasViewportRef.current,
    }
    const steps = 1
    for (let index = 0; index < steps; index += 1) {
      next = applyCanvasNavigation(next, direction, canvasViewportSize, { pan: true })
    }
    const center = {
      x: next.viewport.x + Math.floor(canvasViewportSize.width / 2),
      y: next.viewport.y + Math.floor(canvasViewportSize.height / 2),
    }
    canvasCursorRef.current = center
    canvasViewportRef.current = next.viewport
    flushSync(() => {
      setCanvasCursor(center)
      setCanvasViewport(next.viewport)
      setNotice(null)
    })
  }

  const selectedStickyNote = (): StickyNote | undefined => {
    const notes = boardSnapshotRef.current?.stickyNotes ?? []
    const selectedId = selectedStickyNoteIdRef.current
    const selected = selectedId ? notes.find((note) => note.id === selectedId) : undefined
    return selected ?? nearestCanvasNote(notes, {
      x: canvasViewportRef.current.x + Math.floor(canvasViewportSize.width / 2),
      y: canvasViewportRef.current.y + Math.floor(canvasViewportSize.height / 2),
    })
  }

  const canvasActions = (): CanvasAction[] => {
    const actions: CanvasAction[] = stableModeRef.current === "navigate"
      ? ["add", "select"]
      : selectedStickyNote()
        ? ["info", "edit", "move", "delete", "navigate"]
        : ["navigate"]
    return [...actions, "help"]
  }

  const canvasActionLabel = (action: CanvasAction): string => {
    switch (action) {
      case "add": return "Add Sticky Note"
      case "info": return "Info"
      case "edit": return "Edit"
      case "move": return "Move"
      case "delete": return "Delete"
      case "navigate": return "Switch to Navigate"
      case "select": return "Switch to Select"
      case "help": return "Help"
    }
  }

  const canvasActionDescription = (action: CanvasAction): string => {
    switch (action) {
      case "add": return "Place a new Sticky Note at the center of this view."
      case "info": return "Read the selected Sticky Note and its edit history."
      case "edit": return "Edit the selected Sticky Note body."
      case "move": return "Preview a new position, then commit it."
      case "delete": return "Remove the selected Sticky Note after confirmation."
      case "navigate": return "Pan freely across the canvas with the arrow keys."
      case "select": return "Jump between Sticky Notes with the arrow keys."
      case "help": return "Review the small set of controls available here."
    }
  }

  const openCanvasActions = () => {
    const actions = canvasActions()
    actionMenuIndexRef.current = 0
    flushSync(() => {
      setActionMenuIndex(0)
      setOverlay("actions")
    })
    if (actions.length === 0) {
      flushSync(() => setOverlay("none"))
    }
  }

  const closeCanvasOverlay = () => {
    movingStickyNoteRef.current = null
    infoStickyNoteIdRef.current = null
    flushSync(() => {
      setOverlay("none")
      setInfoStickyNoteId(null)
      setMovingStickyNote(null)
    })
  }

  const openStickyNoteInfo = () => {
    const note = selectedStickyNote()
    if (!note) {
      flushSync(() => setNotice({ kind: "status", message: "No Sticky Note selected." }))
      return
    }
    infoStickyNoteIdRef.current = note.id
    flushSync(() => {
      setInfoStickyNoteId(note.id)
      setOverlay("info")
    })
  }

  const openStickyNoteMove = () => {
    const note = selectedStickyNote()
    if (!note) {
      flushSync(() => setNotice({ kind: "status", message: "No Sticky Note selected." }))
      return
    }
    const moving = { stickyNoteId: note.id, original: { ...note.position }, position: { ...note.position } }
    movingStickyNoteRef.current = moving
    flushSync(() => {
      setMovingStickyNote(moving)
      setOverlay("move")
    })
  }

  const movePreview = (direction: CanvasDirection) => {
    const current = movingStickyNoteRef.current
    if (!current) return
    const delta = direction === "left"
      ? { x: -1, y: 0 }
      : direction === "right"
        ? { x: 1, y: 0 }
        : direction === "up"
          ? { x: 0, y: -1 }
          : { x: 0, y: 1 }
    const next = {
      ...current,
      position: {
        x: Math.max(CANVAS_MIN_COORDINATE, Math.min(CANVAS_MAX_COORDINATE, current.position.x + delta.x)),
        y: Math.max(CANVAS_MIN_COORDINATE, Math.min(CANVAS_MAX_COORDINATE, current.position.y + delta.y)),
      },
    }
    movingStickyNoteRef.current = next
    flushSync(() => setMovingStickyNote(next))
  }

  const commitMovePreview = () => {
    const moving = movingStickyNoteRef.current
    const connection = boardConnectionRef.current
    if (!moving || !connection || !sharedBoardMutationsEnabled()) {
      closeCanvasOverlay()
      return
    }
    const dx = moving.position.x - moving.original.x
    const dy = moving.position.y - moving.original.y
    const sendMoves = (direction: CanvasDirection, count: number) => {
      for (let index = 0; index < Math.abs(count); index += 1) {
        connection.send({
          type: "move_sticky_note",
          stickyNoteId: moving.stickyNoteId,
          direction,
        })
      }
    }
    try {
      sendMoves(dx < 0 ? "left" : "right", dx)
      sendMoves(dy < 0 ? "up" : "down", dy)
      selectedStickyNoteIdRef.current = moving.stickyNoteId
      closeCanvasOverlay()
      flushSync(() => setNotice({ kind: "status", message: "Saving Position…" }))
    } catch (error) {
      flushSync(() => setNotice({ kind: "error", message: formatBoardError(error) }))
    }
  }

  const executeCanvasAction = (action: CanvasAction) => {
    closeCanvasOverlay()
    switch (action) {
      case "add": startProvisionalStickyNote(); return
      case "info": openStickyNoteInfo(); return
      case "edit": startEstablishedStickyNoteEdit(); return
      case "move": openStickyNoteMove(); return
      case "delete": startStickyNoteDeletion(); return
      case "navigate": setStableCanvasMode("navigate"); return
      case "select": setStableCanvasMode("select"); return
      case "help": flushSync(() => setOverlay("help")); return
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
      position: {
        x: canvasViewportRef.current.x + Math.max(0, Math.floor(canvasViewportSize.width / 2) - Math.floor(CANVAS_STICKY_NOTE_CARD_WIDTH / 2)),
        y: canvasViewportRef.current.y + Math.max(0, Math.floor(canvasViewportSize.height / 2) - Math.floor(CANVAS_STICKY_NOTE_CARD_HEIGHT / 2)),
      },
      color: DEFAULT_STICKY_NOTE_COLOR,
      text: "",
      status: "requesting",
      publicationRequested: false,
      saveRequested: false,
    }
    provisionalStickyNoteRef.current = draft
    flushSync(() => {
      setProvisionalStickyNote(draft)
      setStableMode("navigate")
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
      saveRequested: false,
      releaseRequested: false,
      releaseSent: false,
      claimRequestSent: false,
      reconnecting: false,
    }
    selectedStickyNoteIdRef.current = note.id
    establishedStickyNoteEditRef.current = edit
    flushSync(() => {
      setSelectedStickyNoteId(note.id)
      setStableMode("select")
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
        setMode(stableModeRef.current)
        setNotice({ kind: "error", message: formatBoardError(error) })
      })
    }
  }

  const startStickyNoteDeletion = () => {
    if (
      provisionalStickyNoteRef.current ||
      establishedStickyNoteEditRef.current ||
      stickyNoteDeletionRef.current
    ) {
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
        setNotice({ kind: "error", message: "Open a live Board before deleting a Sticky Note." })
      })
      return
    }
    const note = selectedStickyNote()
    if (!note) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Select a Sticky Note before deleting it." })
      })
      return
    }

    const deletion: StickyNoteDeletion = {
      stickyNoteId: note.id,
      note,
      status: "requesting",
    }
    selectedStickyNoteIdRef.current = note.id
    stickyNoteDeletionRef.current = deletion
    flushSync(() => {
      setSelectedStickyNoteId(note.id)
      setStickyNoteDeletion(deletion)
      setMode(stableModeRef.current)
      setSelectedIndex(0)
      setNotice({ kind: "status", message: "Requesting Sticky Note Edit Claim before deletion…" })
    })
    try {
      connection.send({
        type: "begin_sticky_note_edit",
        stickyNoteId: note.id,
      })
    } catch (error) {
      stickyNoteDeletionRef.current = null
      flushSync(() => {
        setStickyNoteDeletion(null)
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
    stableModeRef.current = "navigate"
    modeRef.current = "navigate"
    flushSync(() => {
      setProvisionalStickyNote(null)
      setStableMode("navigate")
      setMode("navigate")
    })
  }

  const discardProvisionalStickyNoteDraft = () => {
    releaseProvisionalStickyNote()
    flushSync(() => {
      setView("canvas")
      setConfirmationAction("placeholder")
      setNotice({ kind: "status", message: "Draft discarded." })
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

  const cancelStickyNoteDeletion = () => {
    const deletion = stickyNoteDeletionRef.current
    if (!deletion) {
      flushSync(() => setView("canvas"))
      return
    }
    if (deletion.status === "deleting") {
      flushSync(() => {
        setNotice({ kind: "status", message: "Deletion is already being committed; confirmation cannot be cancelled." })
      })
      return
    }

    if (deletion.claimId && boardConnectionStateRef.current === "connected") {
      try {
        boardConnectionRef.current?.send({
          type: "release_sticky_note_edit",
          claimId: deletion.claimId,
          stickyNoteId: deletion.stickyNoteId,
        })
      } catch {
        cancelledStickyNoteDeletionIdsRef.current.add(deletion.stickyNoteId)
      }
    } else {
      cancelledStickyNoteDeletionIdsRef.current.add(deletion.stickyNoteId)
    }
    stickyNoteDeletionRef.current = null
    selectedStickyNoteIdRef.current = deletion.stickyNoteId
    const remainingNotes = boardSnapshotRef.current?.stickyNotes ?? []
    const nextStableMode: Exclude<ShellMode, "edit"> = remainingNotes.length > 0
      ? "select"
      : "navigate"
    stableModeRef.current = nextStableMode
    modeRef.current = nextStableMode
    flushSync(() => {
      setStickyNoteDeletion(null)
      setView("canvas")
      setStableMode(nextStableMode)
      setMode(nextStableMode)
      setConfirmationAction("placeholder")
      setSelectedStickyNoteId(deletion.stickyNoteId)
      setNotice({ kind: "status", message: "Sticky Note deletion cancelled; Edit Claim released." })
    })
  }

  const confirmStickyNoteDeletion = () => {
    const deletion = stickyNoteDeletionRef.current
    const connection = boardConnectionRef.current
    if (!deletion || deletion.status !== "confirming" || !deletion.claimId || !connection) {
      return
    }
    if (boardConnectionStateRef.current !== "connected") {
      flushSync(() => setNotice({ kind: "error", message: "Shared mutations are disabled while the Board reconnects." }))
      return
    }
    const next = { ...deletion, status: "deleting" as const }
    stickyNoteDeletionRef.current = next
    flushSync(() => setStickyNoteDeletion(next))
    try {
      connection.send({
        type: "delete_sticky_note",
        claimId: deletion.claimId,
        stickyNoteId: deletion.stickyNoteId,
      })
    } catch (error) {
      stickyNoteDeletionRef.current = deletion
      flushSync(() => {
        setStickyNoteDeletion(deletion)
        setNotice({ kind: "error", message: formatBoardError(error) })
      })
    }
  }

  const releaseEstablishedStickyNoteEdit = () => {
    const edit = establishedStickyNoteEditRef.current
    if (!edit) {
      flushSync(() => setMode(stableModeRef.current))
      return
    }
    if (edit.publicationRequested) {
      flushSync(() => setNotice({ kind: "status", message: "Sticky Note is being saved…" }))
      return
    }
    if (edit.dirty) {
      discardEstablishedStickyNoteEdit()
      return
    }
    if (!edit.claimId || edit.status === "requesting" || edit.reconnecting) {
      cancelledStickyNoteEditIdsRef.current.add(edit.stickyNoteId)
    } else if (!sendEstablishedStickyNoteRelease()) {
      cancelledStickyNoteEditIdsRef.current.add(edit.stickyNoteId)
    }
    clearEstablishedStickyNoteEdit()
    flushSync(() => {
      setMode(stableModeRef.current)
      setConfirmationAction("placeholder")
    })
  }

  const discardEstablishedStickyNoteEdit = () => {
    const edit = establishedStickyNoteEditRef.current
    if (edit?.claimId) {
      if (!sendEstablishedStickyNoteRelease()) {
        cancelledStickyNoteEditIdsRef.current.add(edit.stickyNoteId)
      }
    } else if (edit) {
      cancelledStickyNoteEditIdsRef.current.add(edit.stickyNoteId)
    }
    clearEstablishedStickyNoteEdit()
    flushSync(() => {
      setView("canvas")
      setMode(stableModeRef.current)
      setConfirmationAction("placeholder")
      setNotice({ kind: "status", message: "Draft discarded." })
    })
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
    const grantedDraft = provisionalStickyNoteRef.current
    if (grantedDraft?.provisionalId === claim.provisionalId && grantedDraft.saveRequested) {
      publishFirstStickyNoteSnapshot(grantedDraft.text)
      flushSync(() => setNotice({ kind: "status", message: "Saving Sticky Note…" }))
      return
    }
    flushSync(() => setNotice({ kind: "status", message: "Sticky Note creation authority granted." }))
  }

  const handleStickyNoteEditClaimGranted = (claim: {
    stickyNoteId: string
    claimId: string
    stickyNote: StickyNote
  }) => {
    cancelledStickyNoteEditRequestsRef.current.delete(claim.stickyNoteId)
    cancelledStickyNoteDeletionRequestsRef.current.delete(claim.stickyNoteId)
    if (cancelledStickyNoteDeletionIdsRef.current.delete(claim.stickyNoteId)) {
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

    const deletion = stickyNoteDeletionRef.current
    if (deletion?.stickyNoteId === claim.stickyNoteId) {
      mergeStickyNoteIntoSnapshot(claim.stickyNote, boardSnapshotRef.current?.revision ?? 0)
      const next: StickyNoteDeletion = {
        ...deletion,
        note: claim.stickyNote,
        claimId: claim.claimId,
        status: "confirming",
      }
      stickyNoteDeletionRef.current = next
      selectedStickyNoteIdRef.current = claim.stickyNoteId
      flushSync(() => {
        setStickyNoteDeletion(next)
        setSelectedStickyNoteId(claim.stickyNoteId)
        setView("confirmation")
        setConfirmationReturnView("canvas")
        setConfirmationAction("delete-sticky-note")
        setMode(stableModeRef.current)
        setNotice({ kind: "status", message: "Edit Claim granted. Confirm permanent Sticky Note deletion." })
      })
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
        setMode(stableModeRef.current)
        setNotice({
          kind: "error",
          message: "Edit Claim was lost; authoritative Sticky Note text was reloaded.",
        })
      })
      return
    }

    const text = edit.dirty && edit.text !== claim.stickyNote.text
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
      saveRequested: edit.saveRequested,
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
    if (next.saveRequested) {
      if (next.dirty) {
        publishEstablishedStickyNoteSnapshot(next.text)
        flushSync(() => setNotice({ kind: "status", message: "Saving Sticky Note…" }))
      } else {
        releaseEstablishedStickyNoteEdit()
      }
      return
    }
    // Reconnected drafts remain local until the user explicitly saves them.
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
        setMode(stableModeRef.current)
      })
      return
    }

    if (!note || !claim || !editClaimBelongsToAuthenticatedMember(claim)) {
      stickyNoteDebouncerRef.current?.cancel()
      establishedStickyNoteEditRef.current = null
      flushSync(() => {
        setEstablishedStickyNoteEdit(null)
        setMode(stableModeRef.current)
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
      saveRequested: edit.saveRequested,
      publishedText: undefined,
      claimRequestSent: edit.claimRequestSent,
      reconnecting: true,
    }
    establishedStickyNoteEditRef.current = next
    flushSync(() => {
      setEstablishedStickyNoteEdit(next)
      setMode("edit")
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

  const releaseCancelledStickyNoteDeletionClaimsAfterReconnect = (
    snapshot: BoardSnapshot,
  ): void => {
    const connection = boardConnectionRef.current
    if (!connection || boardConnectionStateRef.current !== "connected") {
      return
    }

    for (const stickyNoteId of [...cancelledStickyNoteDeletionIdsRef.current]) {
      const claim = snapshot.editClaims?.find(
        (currentClaim) => currentClaim.stickyNoteId === stickyNoteId,
      )
      if (!claim) {
        cancelledStickyNoteDeletionIdsRef.current.delete(stickyNoteId)
        cancelledStickyNoteDeletionRequestsRef.current.delete(stickyNoteId)
        continue
      }
      if (!editClaimBelongsToAuthenticatedMember(claim)) {
        cancelledStickyNoteDeletionIdsRef.current.delete(stickyNoteId)
        cancelledStickyNoteDeletionRequestsRef.current.delete(stickyNoteId)
        continue
      }
      if (cancelledStickyNoteDeletionRequestsRef.current.has(stickyNoteId)) {
        continue
      }

      cancelledStickyNoteDeletionRequestsRef.current.add(stickyNoteId)
      try {
        connection.send({ type: "begin_sticky_note_edit", stickyNoteId })
      } catch {
        cancelledStickyNoteDeletionRequestsRef.current.delete(stickyNoteId)
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
      if (draft.claimId) {
        try {
          boardConnectionRef.current?.send({
            type: "release_sticky_note_creation",
            claimId: draft.claimId,
            provisionalId: draft.provisionalId,
          })
        } catch {
          // The durable creation has already been acknowledged.
        }
      }
      provisionalStickyNoteRef.current = null
      flushSync(() => {
        setProvisionalStickyNote(null)
        setStableMode("select")
        setMode("select")
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
      updateEstablishedStickyNoteEdit((current) =>
        current && current.stickyNoteId === edit.stickyNoteId
          ? { ...current, publicationRequested: true, publishedText: localText }
          : current,
      )
      return
    }
    sendEstablishedStickyNoteRelease()
    clearEstablishedStickyNoteEdit()
    flushSync(() => {
      setStableMode("select")
      setMode("select")
      setNotice({ kind: "status", message: "Sticky Note saved." })
    })
  }

  const handleStickyNoteDeleted = (event: {
    revision: number
    stickyNoteId: string
    affectedStickyNotes?: StickyNote[]
  }) => {
    const current = boardSnapshotRef.current
    if (!current) {
      return
    }
    const affectedIds = new Set((event.affectedStickyNotes ?? []).map((note) => note.id))
    const nextNotes = sortCanvasStackingOrder(
      [
        ...(current.stickyNotes ?? [])
          .filter((note) => note.id !== event.stickyNoteId && !affectedIds.has(note.id)),
        ...(event.affectedStickyNotes ?? []),
      ],
    )
    const selectedWasDeleted = selectedStickyNoteIdRef.current === event.stickyNoteId
    const nextSelectedStickyNoteId = selectedWasDeleted
      ? nearestCanvasNote(nextNotes, canvasCursorRef.current)?.id ?? null
      : selectedStickyNoteIdRef.current
    const nextSnapshot = {
      ...current,
      revision: event.revision,
      stickyNotes: nextNotes,
    }
    boardSnapshotRef.current = nextSnapshot
    selectedStickyNoteIdRef.current = nextSelectedStickyNoteId
    const nextSelectedNote = nextSelectedStickyNoteId
      ? nextNotes.find((note) => note.id === nextSelectedStickyNoteId)
      : undefined
    const nextViewport = nextSelectedNote
      ? canvasViewportForStickyNote(nextSelectedNote.position, canvasViewportSize)
      : canvasViewportRef.current
    canvasViewportRef.current = nextViewport
    const deletion = stickyNoteDeletionRef.current
    if (deletion?.stickyNoteId === event.stickyNoteId) {
      stickyNoteDeletionRef.current = null
    }
    flushSync(() => {
      setBoardSnapshot(nextSnapshot)
      setSelectedStickyNoteId(nextSelectedStickyNoteId)
      setCanvasViewport(nextViewport)
      if (deletion?.stickyNoteId === event.stickyNoteId) {
        setStickyNoteDeletion(null)
        setView("canvas")
        setStableMode(nextNotes.length > 0 ? "select" : "navigate")
        setMode(nextNotes.length > 0 ? "select" : "navigate")
        setConfirmationAction("placeholder")
      }
      setNotice({
        kind: "status",
        message: `Sticky Note deleted at Board revision ${event.revision}.`,
      })
    })
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
        setMode(stableModeRef.current)
        setNotice({ kind: "error", message: "Another Member already owns that Sticky Note creation." })
      })
      return
    }
    if (commandError.code === "edit_claim_unavailable") {
      stickyNoteDebouncerRef.current?.cancel()
      const deletion = stickyNoteDeletionRef.current
      if (deletion) {
        stickyNoteDeletionRef.current = null
        flushSync(() => {
          setStickyNoteDeletion(null)
          setView("canvas")
          setMode(stableModeRef.current)
          setConfirmationAction("placeholder")
          setNotice({
            kind: "error",
            message: commandError.claimHolder
              ? `Deletion unavailable; Edit Claim holder: ${commandError.claimHolder.username} (${commandError.claimConnection ?? "connected"}).`
              : commandError.error,
          })
        })
        return
      }
      establishedStickyNoteEditRef.current = null
      flushSync(() => {
        setEstablishedStickyNoteEdit(null)
        setMode(stableModeRef.current)
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
    if (commandError.code === "sticky_note_rejected" && stickyNoteDeletionRef.current) {
      const deletion = stickyNoteDeletionRef.current
      stickyNoteDeletionRef.current = null
      flushSync(() => {
        setStickyNoteDeletion(null)
        setView("canvas")
        setMode(stableModeRef.current)
        setConfirmationAction("placeholder")
        setSelectedStickyNoteId(deletion.stickyNoteId)
        setNotice({ kind: "error", message: commandError.error })
      })
      return
    }
    if (commandError.code === "sticky_note_rejected" && establishedStickyNoteEditRef.current) {
      const edit = establishedStickyNoteEditRef.current
      if (edit.status === "requesting" && !edit.publicationRequested) {
        stickyNoteDebouncerRef.current?.cancel()
        establishedStickyNoteEditRef.current = null
        flushSync(() => {
          setEstablishedStickyNoteEdit(null)
          setMode(stableModeRef.current)
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
          flushSync(() => setMode(stableModeRef.current))
        }
      }
      flushSync(() => setNotice({ kind: "error", message: commandError.error }))
      return
    }
    if (commandError.code === "invalid_edit_claim") {
      if (stickyNoteDeletionRef.current) {
        const deletion = stickyNoteDeletionRef.current
        stickyNoteDeletionRef.current = null
        flushSync(() => {
          setStickyNoteDeletion(null)
          setView("canvas")
          setMode(stableModeRef.current)
          setConfirmationAction("placeholder")
          setSelectedStickyNoteId(deletion.stickyNoteId)
          setNotice({ kind: "error", message: commandError.error })
        })
        return
      }
      if (!establishedStickyNoteEditRef.current?.publicationRequested) {
        stickyNoteDebouncerRef.current?.cancel()
        establishedStickyNoteEditRef.current = null
        flushSync(() => {
          setEstablishedStickyNoteEdit(null)
          setMode(stableModeRef.current)
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
          flushSync(() => setMode(stableModeRef.current))
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
    stickyNoteDebouncerRef.current?.cancel()
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
    stickyNoteDebouncerRef.current?.cancel()
    return true
  }

  const saveActiveStickyNoteDraft = () => {
    const provisional = provisionalStickyNoteRef.current
    const established = establishedStickyNoteEditRef.current
    const text = provisional?.text ?? established?.text ?? ""
    if (provisional && text.trim().length === 0) {
      flushSync(() => setNotice({ kind: "error", message: "Type a visible character before saving." }))
      return
    }
    if (provisional) {
      if (provisional.status === "requesting" || !provisional.claimId) {
        updateProvisionalStickyNote((current) =>
          current && current.provisionalId === provisional.provisionalId
            ? { ...current, saveRequested: true }
            : current,
        )
        flushSync(() => setNotice({ kind: "status", message: "Waiting for creation authority…" }))
        return
      }
      if (provisional.publicationRequested) {
        flushSync(() => setNotice({ kind: "status", message: "Sticky Note is already being saved…" }))
        return
      }
      publishFirstStickyNoteSnapshot(text)
      flushSync(() => setNotice({ kind: "status", message: "Saving Sticky Note…" }))
      return
    }
    if (established && established.status !== "granted") {
      updateEstablishedStickyNoteEdit((current) =>
        current && current.stickyNoteId === established.stickyNoteId
          ? { ...current, saveRequested: true }
          : current,
      )
      flushSync(() => setNotice({ kind: "status", message: "Waiting for Edit Claim…" }))
      return
    }
    if (established?.publicationRequested) {
      flushSync(() => setNotice({ kind: "status", message: "Sticky Note is already being saved…" }))
      return
    }
    if (established && established.dirty) {
      publishEstablishedStickyNoteSnapshot(text)
      flushSync(() => setNotice({ kind: "status", message: "Saving Sticky Note…" }))
      return
    }
    releaseEstablishedStickyNoteEdit()
  }

  const moveSelection = (direction: -1 | 1) => {
    const availableBoardActions = boards.length > 0 ? boardMenu.slice(1) : boardMenu
    const items = viewRef.current === "home"
      ? homeMenu
      : viewRef.current === "boards"
        ? availableBoardActions
        : boardActionsMenu
    const itemCount = viewRef.current === "boards" && boards.length > 0
      ? boards.length + items.length
      : items.length
    const nextIndex = itemCount === 0
      ? 0
      : (selectedIndexRef.current + direction + itemCount) % itemCount
    flushSync(() => {
      setSelectedIndex(nextIndex)
      if (viewRef.current === "boards" && nextIndex < boards.length) {
        setSelectedBoardIndex(nextIndex)
      }
    })
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
    releaseProvisionalStickyNote()
    const deletion = stickyNoteDeletionRef.current
    if (deletion?.claimId && boardConnectionStateRef.current === "connected") {
      try {
        boardConnectionRef.current?.send({
          type: "release_sticky_note_edit",
          claimId: deletion.claimId,
          stickyNoteId: deletion.stickyNoteId,
        })
      } catch {
        // The connection is already closing; the service releases the claim on disconnect.
      }
    }
    stickyNoteDeletionRef.current = null
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
    cancelledStickyNoteDeletionIdsRef.current.clear()
    cancelledStickyNoteDeletionRequestsRef.current.clear()
    boardConnectionStateRef.current = null
    flushSync(() => {
      setEstablishedStickyNoteEdit(null)
      setStickyNoteDeletion(null)
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
      const deletion = stickyNoteDeletionRef.current
      if (deletion?.claimId && boardConnectionStateRef.current === "connected") {
        try {
          boardConnectionRef.current?.send({
            type: "release_sticky_note_edit",
            claimId: deletion.claimId,
            stickyNoteId: deletion.stickyNoteId,
          })
        } catch {
          // The renderer is shutting down; the service releases the claim on disconnect.
        }
      }
      stickyNoteDeletionRef.current = null
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
      setBoardDeleteInitialKey(null)
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

  const handleBoardAuthorizationLoss = (reason: "board_deleted") => {
    if (reason !== "board_deleted") {
      return
    }
    const deletedBoardName = boardSnapshotRef.current?.board.name ??
      boards[selectedBoardIndexRef.current]?.name ??
      "selected Board"
    closeBoardConnection()
    cancelledProvisionalIdsRef.current.clear()
    boardSnapshotRef.current = null
    flushSync(() => {
      setBoardConnectionState(null)
      setBoardSnapshot(null)
      setMode("navigate")
      setBoardOpenPending(false)
      setSelectedStickyNoteId(null)
      setView("boards")
      setSelectedIndex(0)
      setNotice({
        kind: "status",
        message: "Board \"" + deletedBoardName + "\" was deleted. Access ended for every Member.",
      })
    })
    void loadBoards(boardFilterRef.current, false)
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
      setStableMode("navigate")
      setMode("navigate")
      boardSnapshotRef.current = null
      setBoardSnapshot(null)
      boardConnectionStateRef.current = "connecting"
      setBoardConnectionState("connecting")
      selectedStickyNoteIdRef.current = null
      setSelectedStickyNoteId(null)
      establishedStickyNoteEditRef.current = null
      setEstablishedStickyNoteEdit(null)
      setBoardOpenPending(true)
      setNotice(null)
    })

    try {
      const connection = await openBoard(credential, board.id, {
        onSnapshot: (snapshot) => {
          if (!isCurrentBoardConnection()) {
            return
          }
          const firstSnapshot = boardSnapshotRef.current === null
          const initialNavigation = firstSnapshot
            ? resetCanvasNavigation({ render: false })
            : {
                cursor: canvasCursorRef.current,
                viewport: canvasViewportRef.current,
              }
          boardConnectionStateRef.current = "connected"
          boardSnapshotRef.current = snapshot
          const selectedStillExists = selectedStickyNoteIdRef.current && snapshot.stickyNotes?.some(
            (note) => note.id === selectedStickyNoteIdRef.current,
          )
          const noteAtCursor = firstSnapshot
            ? nearestCanvasNote(snapshot.stickyNotes ?? [], { x: 0, y: 0 })
            : stickyNotesAtCanvasCursor(
                snapshot.stickyNotes ?? [],
                canvasCursorRef.current,
              )[0]
          const nextSelectedStickyNoteId = selectedStillExists
            ? selectedStickyNoteIdRef.current
            : noteAtCursor?.id ?? null
          const nextSelectedNote = nextSelectedStickyNoteId
            ? snapshot.stickyNotes?.find((note) => note.id === nextSelectedStickyNoteId)
            : undefined
          const nextViewport = firstSnapshot && nextSelectedNote
            ? canvasViewportForStickyNote(nextSelectedNote.position, canvasViewportSize)
            : initialNavigation.viewport
          const nextCursor = firstSnapshot && nextSelectedNote
            ? { ...nextSelectedNote.position }
            : firstSnapshot
              ? {
                  x: initialNavigation.viewport.x + Math.floor(canvasViewportSize.width / 2),
                  y: initialNavigation.viewport.y + Math.floor(canvasViewportSize.height / 2),
                }
              : initialNavigation.cursor
          const nextStableMode: Exclude<ShellMode, "edit"> = (snapshot.stickyNotes?.length ?? 0) > 0
            ? "select"
            : "navigate"
          const nextMode: ShellMode = provisionalStickyNoteRef.current || establishedStickyNoteEditRef.current
            ? "edit"
            : nextStableMode
          selectedStickyNoteIdRef.current = nextSelectedStickyNoteId
          flushSync(() => {
            setCanvasCursor(nextCursor)
            setCanvasViewport(nextViewport)
            setBoardSnapshot(snapshot)
            setBoardConnectionState("connected")
            setSelectedStickyNoteId(nextSelectedStickyNoteId)
            setStableMode(nextStableMode)
            setMode(nextMode)
            setBoardOpenPending(false)
            setNotice((current) => current?.kind === "error" ? current : null)
          })
          stableModeRef.current = nextStableMode
          modeRef.current = nextMode
          reconcileEstablishedStickyNoteEditFromSnapshot(snapshot)
          releaseCancelledEditClaimsAfterReconnect(snapshot)
          releaseCancelledStickyNoteDeletionClaimsAfterReconnect(snapshot)
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
        onStickyNoteDeleted: (event) => {
          if (isCurrentBoardConnection()) {
            handleStickyNoteDeleted(event)
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
        onAuthorizationLost: (reason) => {
          if (isCurrentBoardConnection()) {
            handleBoardAuthorizationLoss(reason)
          }
        },
        onConnectionState: (state) => {
          if (!isCurrentBoardConnection()) {
            return
          }
          renderBoardConnectionState(state)
          if (state === "connected" && boardSnapshotRef.current) {
            releaseCancelledEditClaimsAfterReconnect(boardSnapshotRef.current)
            releaseCancelledStickyNoteDeletionClaimsAfterReconnect(boardSnapshotRef.current)
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

  const openBoardDeleteConfirmation = (initialKey: string | null = null) => {
    const board = boards[selectedBoardIndexRef.current]
    if (!board) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Select a Board before deleting it." })
      })
      return
    }
    if (board.role !== "owner") {
      flushSync(() => {
        setNotice({ kind: "error", message: "Only the Owner may delete this Board." })
      })
      return
    }

    flushSync(() => {
      setView("board-delete-confirmation")
      setBoardDeleteInitialKey(initialKey)
      setSelectedIndex(0)
      setNotice(null)
    })
  }

  const cancelBoardDeleteConfirmation = () => {
    flushSync(() => {
      setView("board-actions")
      setBoardDeleteInitialKey(null)
      setSelectedIndex(0)
      setNotice(null)
    })
  }

  const deleteSelectedBoard = async (typedName: string) => {
    if (!boardClient?.deleteBoard || boardActionPendingRef.current) {
      return
    }

    const board = boards[selectedBoardIndexRef.current]
    if (!board) {
      cancelBoardDeleteConfirmation()
      flushSync(() => {
        setNotice({ kind: "error", message: "Select a Board before deleting it." })
      })
      return
    }
    if (board.role !== "owner") {
      cancelBoardDeleteConfirmation()
      flushSync(() => {
        setNotice({ kind: "error", message: "Only the Owner may delete this Board." })
      })
      return
    }
    if (typedName !== board.name) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Type the exact current Board name to delete it." })
      })
      return
    }

    flushSync(() => setBoardActionPending(true))
    try {
      const credential = await credentialStore.load()
      if (!credential) {
        throw new Error("No active Terminal Session. Sign in to continue.")
      }
      await boardClient.deleteBoard(credential, board.id)
      flushSync(() => {
        forgetBoardCode(board.id)
        setBoards((currentBoards) =>
          currentBoards.filter((currentBoard) => currentBoard.id !== board.id),
        )
        setSelectedBoardIndex(0)
        setSelectedIndex(0)
        setBoardDeleteInitialKey(null)
        setView("boards")
        setNotice({ kind: "status", message: "Board \"" + board.name + "\" deleted permanently." })
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

  const resolveConfirmation = (confirmed: boolean) => {
    if (confirmationActionRef.current === "delete-sticky-note") {
      if (confirmed) {
        confirmStickyNoteDeletion()
      } else {
        cancelStickyNoteDeletion()
      }
      return
    }
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
        const codeNotice: BoardCodeNotice = {
          boardId: response.board.id,
          boardName: response.board.name,
          kind: "rotated",
          code: response.joinCode,
        }
        setBoards((currentBoards) =>
          currentBoards.map((currentBoard) =>
            currentBoard.id === response.board.id ? response.board : currentBoard,
          ),
        )
        setSelectedIndex(0)
        setView("join-code")
        rememberBoardCode(codeNotice)
        setBoardCodeNotice(codeNotice)
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

  const rememberBoardCode = (nextNotice: BoardCodeNotice) => {
    const nextKnownBoardCodes = {
      ...knownBoardCodesRef.current,
      [nextNotice.boardId]: nextNotice,
    }
    knownBoardCodesRef.current = nextKnownBoardCodes
    setKnownBoardCodes(nextKnownBoardCodes)
  }

  const forgetBoardCode = (boardId: string) => {
    const nextKnownBoardCodes = { ...knownBoardCodesRef.current }
    delete nextKnownBoardCodes[boardId]
    knownBoardCodesRef.current = nextKnownBoardCodes
    setKnownBoardCodes(nextKnownBoardCodes)
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
          setView("boards")
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
        void loadBoards("")
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
          const knownCode = knownBoardCodesRef.current[response.board.id]
          if (knownCode) {
            rememberBoardCode({ ...knownCode, boardName: response.board.name })
          }
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
          const codeNotice: BoardCodeNotice = {
            boardId: response.board.id,
            boardName: response.board.name,
            kind: "initial",
            code: response.joinCode,
          }
          setView("join-code")
          setFormKind(null)
          setFormInitialKey(null)
          setSelectedIndex(0)
          setSelectedBoardIndex(0)
          setBoardFilter("")
          setBoards((currentBoards) => [
            response.board,
            ...currentBoards.filter((currentBoard) => currentBoard.id !== response.board.id),
          ])
          rememberBoardCode(codeNotice)
          setBoardCodeNotice(codeNotice)
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
        knownBoardCodesRef.current = {}
        setAuthenticatedUsername(null)
        setSessionState("signed-out")
        setKnownBoardCodes({})
        setBoardCodeNotice(null)
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

  const copyVisibleJoinCode = () => {
    const visibleJoinCode = boardCodeNoticeRef.current
    if (!visibleJoinCode) {
      return
    }

    const copied = renderer.copyToClipboardOSC52(visibleJoinCode.code)
    flushSync(() => {
      setNotice(copied
        ? { kind: "status", message: "Join Code copied to the clipboard." }
        : {
            kind: "error",
            message: "Clipboard access is unavailable. Select and copy the Join Code manually.",
          })
    })
  }

  const closeJoinCode = () => {
    flushSync(() => {
      setView("boards")
      setBoardCodeNotice(null)
      setSelectedIndex(0)
      setNotice(null)
    })
    void loadBoards(boardFilterRef.current)
  }

  const showSelectedJoinCode = () => {
    const board = boards[selectedBoardIndexRef.current]
    if (!board) {
      flushSync(() => {
        setNotice({ kind: "error", message: "Select a Board before showing its Join Code." })
      })
      return
    }
    if (board.role !== "owner") {
      flushSync(() => {
        setNotice({ kind: "error", message: "Only the Owner may view this Board's Join Code." })
      })
      return
    }

    const knownCode = knownBoardCodesRef.current[board.id]
    if (!knownCode) {
      flushSync(() => {
        setNotice({
          kind: "error",
          message: "This Terminal Session does not know the current Join Code. Rotate it to issue a new one.",
        })
      })
      return
    }

    flushSync(() => {
      setView("join-code")
      setSelectedIndex(selectedBoardIndexRef.current)
      setBoardCodeNotice({ ...knownCode, boardName: board.name })
      setNotice({ kind: "status", message: `Showing Join Code for Board "${board.name}".` })
    })
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      renderer.destroy()
      return
    }
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
      if (key.name === "up") {
        moveSelection(-1)
        return
      }
      if (key.name === "down") {
        moveSelection(1)
        return
      }
      if (key.name === "return" && selectedIndexRef.current === 0) {
        openView("boards")
        return
      }
      if (key.name === "return" && selectedIndexRef.current === 1) {
        openForm("sign-in", "home", key.name)
        return
      }
      if (key.name === "return" && selectedIndexRef.current === 2) {
        openForm("register", "home", key.name)
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
      if (key.name === "up") {
        moveSelection(-1)
        return
      }
      if (key.name === "down") {
        moveSelection(1)
        return
      }
      if (key.name === "c" && boardCodeNoticeRef.current) {
        copyVisibleJoinCode()
        return
      }
      if (key.name === "return") {
        if (boards.length > 0 && selectedIndexRef.current < boards.length) {
          void openSelectedBoard()
          return
        }
        const actionIndex = selectedIndexRef.current - boards.length
        if (boards.length === 0) {
          switch (actionIndex) {
            case 0:
              void openSelectedBoard()
              return
            case 1:
              openForm("create-board", "boards", key.name)
              return
            case 2:
              openForm("join-board", "boards", key.name)
              return
            case 3:
              openView("board-actions")
              return
          }
        } else {
          switch (actionIndex) {
            case 0:
              openForm("create-board", "boards", key.name)
              return
            case 1:
              openForm("join-board", "boards", key.name)
              return
            case 2:
              openView("board-actions")
              return
          }
        }
      }
    }

    if (viewRef.current === "join-code") {
      if (key.name === "c") {
        copyVisibleJoinCode()
        return
      }
      if (key.name === "escape" || key.name === "return") {
        closeJoinCode()
      }
      return
    }

    if (viewRef.current === "canvas") {
      if (overlayRef.current === "actions") {
        const actions = canvasActions()
        if (key.name === "escape") {
          closeCanvasOverlay()
          return
        }
        if (key.name === "up") {
          const next = Math.max(0, actionMenuIndexRef.current - 1)
          actionMenuIndexRef.current = next
          flushSync(() => setActionMenuIndex(next))
          return
        }
        if (key.name === "down") {
          const next = Math.min(actions.length - 1, actionMenuIndexRef.current + 1)
          actionMenuIndexRef.current = next
          flushSync(() => setActionMenuIndex(next))
          return
        }
        if (key.name === "return") {
          key.preventDefault()
          executeCanvasAction(actions[actionMenuIndexRef.current] ?? "help")
          return
        }
        return
      }
      if (overlayRef.current === "info") {
        if (key.name === "escape" || key.name === "space") {
          closeCanvasOverlay()
          return
        }
        if (key.name === "return") {
          key.preventDefault()
          closeCanvasOverlay()
          startEstablishedStickyNoteEdit()
          return
        }
        return
      }
      if (overlayRef.current === "move") {
        if (key.name === "escape") {
          closeCanvasOverlay()
          return
        }
        if (key.name === "return") {
          commitMovePreview()
          return
        }
        const direction = canvasDirectionForKey(key.name)
        if (direction) {
          movePreview(direction)
        }
        return
      }

      if (provisionalStickyNoteRef.current || establishedStickyNoteEditRef.current) {
        if (
          isStickyNoteSaveKey(
            key.name,
            key.ctrl,
            (capabilitiesOverride ?? detectedCapabilities)?.kitty_keyboard ?? false,
          )
        ) {
          key.preventDefault()
          key.stopPropagation()
          saveActiveStickyNoteDraft()
          return
        }
        if (key.name === "escape") {
          key.preventDefault()
          key.stopPropagation()
          if (provisionalStickyNoteRef.current) {
            if (provisionalStickyNoteRef.current.publicationRequested) {
              flushSync(() => setNotice({ kind: "status", message: "Sticky Note is being saved…" }))
            } else {
              discardProvisionalStickyNoteDraft()
            }
          } else if (establishedStickyNoteEditRef.current) {
            releaseEstablishedStickyNoteEdit()
          }
          return
        }
        if (
          (provisionalStickyNoteRef.current?.publicationRequested ||
            establishedStickyNoteEditRef.current?.publicationRequested) &&
          key.name !== "escape"
        ) {
          key.preventDefault()
          key.stopPropagation()
          return
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
        return
      }
      if (key.name === "space") {
        openCanvasActions()
        return
      }
      if (key.name === "tab") {
        key.preventDefault()
        setStableCanvasMode(stableModeRef.current === "navigate" ? "select" : "navigate")
        return
      }
      if (key.name === "return") {
        key.preventDefault()
        if (stableModeRef.current === "navigate") {
          startProvisionalStickyNote()
        } else {
          startEstablishedStickyNoteEdit()
        }
        return
      }
      const direction = canvasDirectionForKey(key.name)
      if (direction && !key.ctrl && !key.meta && !key.option && !key.super && !key.hyper) {
        key.preventDefault()
        updateCanvasNavigation(direction)
        return
      }
      if (key.name === "escape") {
        openView("boards")
        return
      }
      if (key.name === "?") {
        flushSync(() => setOverlay("help"))
        return
      }
      return
    }

    if (viewRef.current === "board-actions") {
      if (key.name === "escape") {
        openView("boards")
        return
      }
      if (key.name === "left") {
        moveBoardSelection(-1)
        return
      }
      if (key.name === "right") {
        moveBoardSelection(1)
        return
      }
      if (key.name === "up") {
        moveSelection(-1)
        return
      }
      if (key.name === "down") {
        moveSelection(1)
        return
      }
      if (key.name === "return") {
        switch (selectedIndexRef.current) {
          case 0: openBoardDeleteConfirmation(key.name); return
          case 1: openLeaveConfirmation(); return
          case 2: openForm("rename-board", "board-actions", key.name); return
          case 3: showSelectedJoinCode(); return
          case 4: void rotateSelectedJoinCode(); return
        }
      }
    }

    if (viewRef.current === "board-delete-confirmation") {
      if (key.name === "escape") {
        cancelBoardDeleteConfirmation()
      }
      return
    }

    if (viewRef.current === "confirmation") {
      if (key.name === "left" || key.name === "right") {
        const next = selectedIndexRef.current === 0 ? 1 : 0
        flushSync(() => setSelectedIndex(next))
        return
      }
      if (key.name === "return") {
        const confirmed = selectedIndexRef.current === 1
        if (confirmed && confirmationActionRef.current === "leave") {
          void leaveSelectedBoard()
        } else {
          resolveConfirmation(confirmed)
        }
        return
      }
      if (key.name === "escape") {
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

    return
  })

  if (width < MIN_TERMINAL_WIDTH || height < MIN_TERMINAL_HEIGHT) {
    return <ResizeRequiredScreen width={width} height={height} />
  }

  const activeCanvasActions = view === "canvas" ? canvasActions() : []
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
      canSelectBoard={boards.length > 1}
      status={notice?.kind === "status" ? notice.message : "choose an action"}
      error={notice?.kind === "error" ? notice.message : undefined}
    />
  ) : view === "join-code" && boardCodeNotice ? (
    <JoinCodeScreen
      joinCode={boardCodeNotice}
      notice={notice}
      onCopy={copyVisibleJoinCode}
    />
  ) : view === "board-delete-confirmation" ? (
    <BoardDeleteConfirmation
      board={boards[selectedBoardIndex]}
      initialKeyToIgnore={boardDeleteInitialKey}
      notice={notice}
      pending={boardActionPending}
      onCancel={cancelBoardDeleteConfirmation}
      onEdit={() => {
        if (notice?.kind === "error") setNotice(null)
      }}
      onSubmit={deleteSelectedBoard}
    />
  ) : view === "confirmation" ? (
    <ShellConfirmation
      action={confirmationAction}
      deletion={stickyNoteDeletion}
      selectedIndex={selectedIndex}
    />
  ) : view === "canvas" ? (
    <CanvasSurface
      mode={mode}
      stableMode={stableMode}
      overlay={overlay}
      snapshot={boardSnapshot}
      connectionState={boardConnectionState}
      pending={boardOpenPending}
      error={notice?.kind === "error" ? notice.message : undefined}
      status={notice?.kind === "status" ? notice.message : undefined}
      cursor={canvasCursor}
      viewport={canvasViewport}
      viewportSize={canvasViewportSize}
      selectedStickyNoteId={selectedStickyNoteId ?? stickyNotesAtCanvasCursor(
        boardSnapshot?.stickyNotes ?? [],
        canvasCursor,
      )[0]?.id ?? null}
      authenticatedUsername={authenticatedUsername}
      provisionalStickyNote={provisionalStickyNote}
      establishedStickyNoteEdit={establishedStickyNoteEdit}
      infoNote={infoStickyNoteId
        ? boardSnapshot?.stickyNotes?.find((note) => note.id === infoStickyNoteId) ?? null
        : null}
      movingStickyNote={movingStickyNote}
      actionItems={activeCanvasActions.map((action) => canvasActionLabel(action))}
      actionDescriptions={activeCanvasActions.map((action) => canvasActionDescription(action))}
      actionMenuIndex={actionMenuIndex}
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
      onEdit={() => {
        if (notice?.kind === "error") setNotice(null)
      }}
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
      hasBoardClient={Boolean(boardClient)}
      sessionState={sessionState}
    />
  )
  const footerHint =
    overlay === "help"
      ? "Escape close"
      : view === "form"
      ? "↑↓ fields · Enter submit · Escape cancel"
        : view === "board-delete-confirmation"
          ? "Type exact Board name · Enter delete permanently · Escape cancel"
        : view === "confirmation"
          ? confirmationAction === "delete-sticky-note"
            ? "←→ choose · Enter delete · Escape cancel"
            : "←→ choose · Enter confirm · Escape cancel"
          : view === "canvas"
            ? mode === "edit"
              ? "Ctrl+Enter save · Escape cancel"
              : `${boardSnapshot?.board.name ?? "Board"} · ${boardConnectionState === "connected" ? "Connected" : boardConnectionState ?? "Connecting"} · ${boardSnapshot?.presence.length ?? 0} online · Space actions`
          : view === "boards"
            ? "? help · Ctrl+C quit"
            : view === "join-code"
              ? "c copy · Enter done · Escape done"
          : "? help · Ctrl+C quit"

  return (
    <ShellFrame
      label={view === "canvas" ? "" : authenticatedUsername ?? label}
      mode={mode}
      capabilities={capabilitiesOverride ?? detectedCapabilities}
      footerHint={footerHint}
      highlightSpaceActions={view === "canvas" && mode !== "edit"}
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
  highlightSpaceActions,
  children,
}: {
  label: string
  mode: ShellMode
  capabilities: TerminalCapabilities | null
  footerHint: string
  highlightSpaceActions: boolean
  children: ReactNode
}) {
  const modeLabel = mode === "edit" ? "EDIT" : mode.toUpperCase()
  const modeColor = mode === "edit"
    ? colors.warning
    : mode === "select"
      ? colors.accentStrong
      : colors.accent

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: colors.background,
        flexDirection: "column",
      }}
    >
      <box style={{ flexGrow: 1, width: "100%", minHeight: 0 }}>{children}</box>
      <box
        style={{
          width: "100%",
          height: 1,
          paddingX: 2,
          flexDirection: "row",
          gap: 2,
          flexShrink: 0,
        }}
      >
        <text fg={modeColor} style={{ flexShrink: 0 }}>{modeLabel}</text>
        {highlightSpaceActions ? (
          <box style={{ flexDirection: "row", flexShrink: 1 }}>
            <text fg={colors.muted}>{footerHint.slice(0, -"Space actions".length)}</text>
            <text fg={colors.accentInk} bg={colors.accent}>Space actions</text>
          </box>
        ) : (
          <text fg={colors.muted} style={{ flexShrink: 1 }}>{footerHint}</text>
        )}
        <box style={{ flexGrow: 1 }} />
        <text fg={colors.subtle} style={{ flexShrink: 0 }}>{label}</text>
      </box>
    </box>
  )
}

function MenuRow({
  label,
  selected,
  detail,
  tone = "default",
}: {
  label: string
  selected: boolean
  detail?: string
  tone?: "default" | "danger"
}) {
  const markerColor = tone === "danger" ? colors.error : colors.accent
  return (
    <box
      style={{
        height: 1,
        width: "100%",
        backgroundColor: selected ? colors.panelActive : undefined,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: "row",
      }}
    >
      <text fg={selected ? markerColor : colors.subtle} style={{ width: 2 }}>
        {selected ? "›" : " "}
      </text>
      <text fg={selected ? colors.text : tone === "danger" ? colors.error : colors.text}>
        {label}
        {detail ? <span style={{ fg: selected ? colors.muted : colors.subtle }}> · {detail}</span> : null}
      </text>
      <box style={{ flexGrow: 1 }} />
      {selected ? <text fg={markerColor}>Enter</text> : null}
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
      heroTitle="TUISCRIB"
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
      statusColor={sessionState === "checking" ? colors.loading : undefined}
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
  hasBoardClient,
  sessionState,
}: {
  selectedIndex: number
  boards: BoardSummary[]
  selectedBoardIndex: number
  filter: string
  pending: boolean
  notice: ShellNotice | null
  hasBoardClient: boolean
  sessionState: SessionState
}) {
  const availableActions = boards.length > 0 ? boardMenu.slice(1) : boardMenu
  const selectedAction = selectedIndex >= boards.length
    ? availableActions[selectedIndex - boards.length]
    : undefined
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
          width: SHELL_PANEL_WIDTH,
          height: SHELL_BOARD_PANEL_HEIGHT,
          backgroundColor: colors.panel,
          border: true,
          borderStyle: "single",
          borderColor: colors.border,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
          <box style={{ width: "100%", alignItems: "center" }}>
            <text fg={colors.accentStrong}>Boards</text>
          </box>
          <text fg={colors.muted}>{filter ? `Search: ${filter}` : "Your shared Boards"}</text>
          {pending ? <text fg={colors.muted}>Loading…</text> : null}
          {!pending && hasBoardClient && sessionState !== "signed-in" ? (
            <text fg={colors.warning}>Sign in to load Memberships.</text>
          ) : null}
          {!pending && hasBoardClient && sessionState === "signed-in" && boards.length === 0 ? (
            <text fg={colors.muted}>No Memberships match this filter.</text>
          ) : null}
          {boards.map((board, index) => (
            <MenuRow
              key={board.id}
              label={board.name}
              detail={board.role === "owner" ? "Owner" : "Member"}
              selected={index === selectedIndex}
            />
          ))}
          {availableActions.map((item, index) => (
            <MenuRow
              key={item.id}
              label={item.label}
              selected={index + boards.length === selectedIndex}
            />
          ))}
          {selectedAction ? <text fg={colors.subtle}>{selectedAction.description}</text> : null}
        </box>
        <box style={{ flexDirection: "column", flexShrink: 0 }}>
          {notice?.kind === "error" ? <text fg={colors.error}>Error: {notice.message}</text> : null}
          {notice?.kind === "status" ? <text fg={colors.success}>Status: {notice.message}</text> : null}
          <text fg={colors.muted}>
            ↑↓ choose · Enter select · Esc back
          </text>
        </box>
      </box>
    </box>
  )
}

function JoinCodeScreen({
  joinCode,
  onCopy,
  notice,
}: {
  joinCode: BoardCodeNotice
  onCopy: () => void
  notice: ShellNotice | null
}) {
  const renderer = useRenderer()
  const [copyHovered, setCopyHovered] = useState(false)

  return (
    <box style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
      <box
        style={{
          width: SHELL_PANEL_WIDTH,
          height: SHELL_JOIN_CODE_PANEL_HEIGHT,
          backgroundColor: colors.panel,
          border: true,
          borderStyle: "single",
          borderColor: colors.accent,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.accentStrong}>{joinCode.kind === "initial" ? "Board created" : "Join Code rotated"}</text>
        <text fg={colors.text}>{joinCode.boardName}</text>
        <text fg={colors.muted}>Share this code with people who should become Members.</text>
        <box style={{ width: "100%", height: 3, marginTop: 1, backgroundColor: colors.input, paddingX: 2, justifyContent: "center" }}>
          <text selectable fg={colors.success} attributes={menuTitleAttributes}>{joinCode.code}</text>
        </box>
        <box style={{ width: "100%", flexDirection: "row", marginTop: 1 }}>
          <box
            onMouseDown={onCopy}
            onMouseOver={() => {
              setCopyHovered(true)
              renderer.setMousePointer("pointer")
            }}
            onMouseOut={() => {
              setCopyHovered(false)
              renderer.setMousePointer("default")
            }}
            style={{
              height: 1,
              backgroundColor: copyHovered ? colors.accentStrong : colors.accent,
              paddingX: 2,
            }}
          >
            <text fg={colors.accentInk}>[ c ] Copy Join Code</text>
          </box>
          <box style={{ flexGrow: 1 }} />
          <text fg={colors.muted}>Enter done · Escape done</text>
        </box>
        {notice?.kind === "status" ? <text fg={colors.success}>{notice.message}</text> : null}
        {notice?.kind === "error" ? <text fg={colors.error}>{notice.message}</text> : null}
      </box>
    </box>
  )
}

function BoardActions({
  selectedIndex,
  selectedBoard,
  canSelectBoard,
  status,
  error,
}: {
  selectedIndex: number
  selectedBoard: BoardSummary | undefined
  canSelectBoard: boolean
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
      navigationHint={canSelectBoard
        ? "←→ select Board · ↑↓ choose · Enter select · Esc back"
        : undefined}
    />
  )
}

function BoardDeleteConfirmation({
  board,
  initialKeyToIgnore,
  notice,
  pending,
  onCancel,
  onEdit,
  onSubmit,
}: {
  board: BoardSummary | undefined
  initialKeyToIgnore: string | null
  notice: ShellNotice | null
  pending: boolean
  onCancel: () => void
  onEdit: () => void
  onSubmit: (typedName: string) => void | Promise<void>
}) {
  const inputRef = useRef<InputRenderable | null>(null)
  const typedNameRef = useRef("")
  const initialKeyToIgnoreRef = useRef(initialKeyToIgnore)

  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])

  useKeyboard((key) => {
    if (pending) {
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
          width: SHELL_PANEL_WIDTH,
          height: SHELL_BOARD_PANEL_HEIGHT,
          backgroundColor: colors.panel,
          border: true,
          borderStyle: "single",
          borderColor: colors.border,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.error}>Permanently delete Board</text>
        {board ? (
          <>
            <text fg={colors.text}>Board: {board.name}</text>
            <text fg={colors.warning}>
              This permanently removes the Board, Memberships, Sticky Notes, and Join Code.
            </text>
            <text fg={colors.muted}>Every connected Member will lose access immediately.</text>
            <box style={{ width: "100%", flexDirection: "row" }}>
              <text fg={colors.muted} style={{ width: 28 }}>Type Board name exactly:</text>
              <input
                ref={(input) => {
                  inputRef.current = input
                }}
                focused
                width={38}
                maxLength={80}
                placeholder={board.name}
                backgroundColor={colors.input}
                focusedBackgroundColor={colors.dangerSurface}
                textColor={colors.text}
                focusedTextColor={colors.text}
                cursorColor={colors.error}
                onInput={(value) => {
                  if (initialKeyToIgnoreRef.current && value === initialKeyToIgnoreRef.current) {
                    if (inputRef.current) {
                      inputRef.current.value = ""
                    }
                    initialKeyToIgnoreRef.current = null
                    return
                  }
                  initialKeyToIgnoreRef.current = null
                  typedNameRef.current = value
                  onEdit()
                }}
                onSubmit={() => {
                  if (initialKeyToIgnoreRef.current === "return") {
                    initialKeyToIgnoreRef.current = null
                    return
                  }
                  onSubmit(typedNameRef.current)
                }}
              />
            </box>
            <text fg={colors.subtle}>Confirmation must match <span style={{ fg: colors.accentStrong }}>{board.name}</span>.</text>
            {pending ? <text fg={colors.loading}>Deleting Board transactionally…</text> : null}
            {notice?.kind === "error" ? (
              <box style={{ width: "100%", height: 1, backgroundColor: colors.dangerSurface, paddingX: 1 }}>
                <text fg={colors.error}>Error: {notice.message}</text>
              </box>
            ) : null}
            <text fg={colors.warning}>Enter permanently delete · Escape cancel</text>
          </>
        ) : (
          <text fg={colors.error}>No Board is selected.</text>
        )}
      </box>
    </box>
  )
}

function ShellConfirmation({
  action,
  deletion,
  selectedIndex,
}: {
  action: ConfirmationAction
  deletion: StickyNoteDeletion | null
  selectedIndex: number
}) {
  const deletingStickyNote = action === "delete-sticky-note" && deletion
  const confirmLabel = deletingStickyNote
    ? "Delete permanently"
    : action === "leave"
      ? "Leave Board"
      : "Confirm"
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
          width: SHELL_PANEL_WIDTH,
          height: SHELL_CONFIRMATION_PANEL_HEIGHT,
          backgroundColor: colors.panel,
          border: true,
          borderStyle: "single",
          borderColor: colors.border,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={deletingStickyNote ? colors.error : colors.warning}>
          {deletingStickyNote
            ? "Permanently delete Sticky Note"
            : action === "leave"
              ? "Confirm leaving Board"
              : "Confirm Board action"}
        </text>
        {deletingStickyNote ? (
          <>
            <text fg={colors.text}>Sticky Note: {previewStickyNoteText(deletion.note.text)}</text>
            <text fg={colors.warning}>This permanently changes shared Board state.</text>
            <text fg={colors.muted}>
              {deletion.status === "deleting"
                ? "Deletion is being committed before acknowledgement…"
                : "The Edit Claim is held for this confirmation."}
            </text>
          </>
        ) : (
          <>
            <text fg={colors.text}>This action changes shared Board state.</text>
            <text fg={colors.muted}>Review the action before continuing.</text>
          </>
        )}
        <box style={{ width: "100%", height: 1, flexDirection: "row", gap: 2 }}>
          <ConfirmationChoice label="Cancel" selected={selectedIndex === 0} />
          <ConfirmationChoice
            label={confirmLabel}
            selected={selectedIndex === 1}
            tone={deletingStickyNote ? "danger" : "default"}
          />
        </box>
        <text fg={colors.warning}>
          ←→ choose · Enter {deletingStickyNote ? "delete" : "confirm"} · Escape cancel
        </text>
      </box>
    </box>
  )
}

function ConfirmationChoice({
  label,
  selected,
  tone = "default",
}: {
  label: string
  selected: boolean
  tone?: "default" | "danger"
}) {
  const selectedColor = tone === "danger" ? colors.error : colors.accent
  return (
    <box
      style={{
        width: 32,
        height: 1,
        paddingX: 1,
        backgroundColor: selected
          ? tone === "danger"
            ? colors.dangerSurface
            : colors.panelActive
          : colors.panelStrong,
        flexDirection: "row",
      }}
    >
      <text fg={selected ? selectedColor : colors.muted}>
        {selected ? "› " : "  "}{label}
      </text>
      <box style={{ flexGrow: 1 }} />
      {selected ? <text fg={selectedColor}>Enter</text> : null}
    </box>
  )
}

function previewStickyNoteText(text: string): string {
  const oneLine = text.replaceAll("\n", " ")
  return oneLine.length > 48 ? `${oneLine.slice(0, 45)}…` : oneLine
}

function CanvasSurface({
  mode,
  stableMode,
  overlay,
  snapshot,
  connectionState,
  pending,
  error,
  status,
  cursor,
  viewport,
  viewportSize,
  selectedStickyNoteId,
  authenticatedUsername,
  provisionalStickyNote,
  establishedStickyNoteEdit,
  infoNote,
  movingStickyNote,
  actionItems,
  actionDescriptions,
  actionMenuIndex,
  onProvisionalTextChange,
  onEstablishedTextChange,
}: {
  mode: ShellMode
  stableMode: Exclude<ShellMode, "edit">
  overlay: ShellOverlay
  snapshot: BoardSnapshot | null
  connectionState: BoardConnectionState | null
  pending: boolean
  error?: string
  status?: string
  cursor: StickyNotePosition
  viewport: StickyNotePosition
  viewportSize: CanvasViewportSize
  selectedStickyNoteId: string | null
  authenticatedUsername: string | null
  provisionalStickyNote: ProvisionalStickyNote | null
  establishedStickyNoteEdit: EstablishedStickyNoteEdit | null
  infoNote: StickyNote | null
  movingStickyNote: MovingStickyNote | null
  actionItems: string[]
  actionDescriptions: string[]
  actionMenuIndex: number
  onProvisionalTextChange(text: string): boolean
  onEstablishedTextChange(text: string): boolean
}) {
  const notes = snapshot?.stickyNotes ?? []
  const visibleNotes = sortCanvasStackingOrder(
    notes.filter((note) => canvasRectIntersectsViewport(
      stickyNoteCanvasFootprint(note),
      viewport,
      viewportSize,
    )),
  )
  const editorOpen = Boolean(provisionalStickyNote || establishedStickyNoteEdit)
  const overlayPanelInset = 6
  const overlayPanelWidth = CANVAS_OVERLAY_WIDTH
  const overlayPanelHeight = CANVAS_OVERLAY_HEIGHT
  const overlayPanelTop = Math.max(0, Math.floor((viewportSize.height - overlayPanelHeight) / 2))
  const editorHeight = Math.max(3, overlayPanelHeight - 10)
  const cursorScreen = canvasCoordinateToScreen(cursor, viewport)
  const connectionMessage = connectionState === "connecting" || pending
    ? "Opening Board…"
    : connectionState === "reconnecting"
      ? "Reconnecting…"
      : connectionState === "waking"
        ? "Waking the Tuiscrib Service…"
        : connectionState === "unavailable"
          ? "Service unavailable"
          : connectionState === "unauthorized"
            ? "Session unauthorized"
            : connectionState === "closed"
              ? "Board connection closed"
              : null

  return (
    <box
        style={{
          width: "100%",
          height: "100%",
          backgroundColor: colors.canvas,
          position: "relative",
          overflow: "hidden",
      }}
    >
      <box
        style={{
          width: viewportSize.width,
          height: viewportSize.height,
          backgroundColor: colors.canvas,
          position: "absolute",
          left: 0,
          top: 0,
          overflow: "hidden",
        }}
      >
        {stableMode === "navigate" && mode !== "edit" ? (
          <text
            fg={colors.accent}
            style={{ position: "absolute", left: cursorScreen.x, top: cursorScreen.y, zIndex: 0 }}
          >
            ·
          </text>
        ) : null}
        {visibleNotes.map((note) => {
          const position = movingStickyNote?.stickyNoteId === note.id
            ? movingStickyNote.position
            : note.position
          const screen = canvasCoordinateToScreen(position, viewport)
          const claim = (snapshot?.editClaims ?? []).find((item) => item.stickyNoteId === note.id)
          return (
            <StickyNoteCard
              key={note.id}
              note={note}
              selected={stableMode === "select" && note.id === selectedStickyNoteId}
              claimed={Boolean(claim && claim.holder.username !== authenticatedUsername)}
              left={screen.x}
              top={screen.y}
            />
          )
        })}
        {!connectionMessage && (!snapshot || notes.length === 0) ? (
          <box style={{ position: "absolute", left: Math.max(0, Math.floor(viewportSize.width / 2) - 14), top: Math.max(0, Math.floor(viewportSize.height / 2) - 1), width: 28 }}>
            <text fg={colors.muted}>No Sticky Notes yet</text>
            <text fg={colors.text}>Enter to add one</text>
          </box>
        ) : null}
        {connectionMessage ? (
          <box style={{ position: "absolute", left: Math.max(0, Math.floor(viewportSize.width / 2) - 18), top: Math.max(0, Math.floor(viewportSize.height / 2) - 1), width: 36 }}>
            <text fg={connectionState === "unavailable" || connectionState === "unauthorized" || connectionState === "closed" ? colors.error : colors.accent}>{connectionMessage}</text>
            {error ? <text fg={colors.muted}>{error}</text> : null}
          </box>
        ) : null}
      </box>

      {(editorOpen || (overlay !== "none" && overlay !== "help" && overlay !== "move")) ? (
        <box style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", backgroundColor: colors.overlay, opacity: 0.82, zIndex: 100 }} />
      ) : null}

      {overlay === "actions" ? (
        <OpenCodePanel width={CANVAS_ACTION_PANEL_WIDTH} height={CANVAS_ACTION_PANEL_HEIGHT} left={Math.floor((viewportSize.width - CANVAS_ACTION_PANEL_WIDTH) / 2)} top={Math.max(1, Math.floor((viewportSize.height - CANVAS_ACTION_PANEL_HEIGHT) / 2))} zIndex={200}>
          <text fg={colors.accentStrong}>Actions</text>
          <text fg={colors.muted}>Choose what to do with this view.</text>
          <box style={{ marginTop: 1, flexDirection: "column" }}>
            {actionItems.map((item, index) => (
              <MenuRow
                key={item}
                label={item}
                selected={index === actionMenuIndex}
                tone={item === "Delete" ? "danger" : "default"}
              />
            ))}
          </box>
          <text fg={colors.subtle}>{actionDescriptions[actionMenuIndex] ?? ""}</text>
          <text fg={colors.muted}>↑↓ choose · Enter select · Esc close</text>
        </OpenCodePanel>
      ) : null}

      {overlay === "info" && infoNote ? (
        <OpenCodePanel width={overlayPanelWidth} height={overlayPanelHeight} left={Math.max(0, Math.floor((viewportSize.width - overlayPanelWidth) / 2))} top={overlayPanelTop} zIndex={200}>
          <text fg={colors.accentStrong}>Sticky Note</text>
          <text fg={colors.muted}>{infoNote.authorship.member.username} · last edit by {infoNote.lastEdit.member.username} at {infoNote.lastEdit.at}</text>
          <box style={{ marginTop: 1, flexGrow: 1, minHeight: 0 }}>
            <text fg={colors.text} wrapMode="word" width={overlayPanelWidth - overlayPanelInset}>{infoNote.text}</text>
          </box>
          <text fg={colors.muted}>Enter edit · Esc close</text>
        </OpenCodePanel>
      ) : null}

      {overlay === "move" && movingStickyNote ? (
        <box
          style={{
            position: "absolute",
            left: Math.max(1, Math.floor((viewportSize.width - CANVAS_MOVE_PANEL_WIDTH) / 2)),
            top: 1,
            width: CANVAS_MOVE_PANEL_WIDTH,
            height: CANVAS_MOVE_PANEL_HEIGHT,
            backgroundColor: colors.panel,
            border: true,
            borderStyle: "single",
            borderColor: colors.accent,
            paddingX: 1,
            alignItems: "center",
            justifyContent: "center",
            zIndex: 200,
          }}
        >
          <text fg={colors.accentStrong}>
            Move Sticky Note · ({movingStickyNote.position.x}, {movingStickyNote.position.y}) · arrows move · Enter save · Esc cancel
          </text>
        </box>
      ) : null}

      {editorOpen ? (
        <OpenCodePanel width={overlayPanelWidth} height={overlayPanelHeight} left={Math.max(0, Math.floor((viewportSize.width - overlayPanelWidth) / 2))} top={overlayPanelTop} zIndex={250}>
          <text fg={colors.accentStrong}>{provisionalStickyNote ? "Add Sticky Note" : "Edit Sticky Note"}</text>
          <text fg={colors.muted}>{provisionalStickyNote?.status === "requesting" || establishedStickyNoteEdit?.status === "requesting" ? "Requesting Edit Claim…" : "Ctrl+Enter save · Esc cancel"}</text>
          <box style={{ marginTop: 1, flexGrow: 1, minHeight: 0 }}>
            <StickyNoteEditor
              draft={{
                editorId: provisionalStickyNote?.provisionalId ?? establishedStickyNoteEdit?.stickyNoteId ?? "editor",
                text: provisionalStickyNote?.text ?? establishedStickyNoteEdit?.text ?? "",
                status: provisionalStickyNote?.status ?? establishedStickyNoteEdit?.status ?? "editing",
              }}
              mode="edit"
              width={overlayPanelWidth - overlayPanelInset}
              height={editorHeight}
              onTextChange={provisionalStickyNote ? onProvisionalTextChange : onEstablishedTextChange}
            />
          </box>
        </OpenCodePanel>
      ) : null}

      {(status || (!connectionMessage && error)) ? (
        <box style={{ position: "absolute", left: 2, bottom: 1, zIndex: 300 }}>
          <text fg={error ? colors.error : colors.success}>{error ?? status}</text>
        </box>
      ) : null}
    </box>
  )
}

function OpenCodePanel({
  width,
  height,
  left,
  top,
  zIndex,
  children,
}: {
  width: number
  height?: number
  left: number
  top: number
  zIndex: number
  children: ReactNode
}) {
  return (
    <box
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        backgroundColor: colors.panel,
        border: true,
        borderStyle: "single",
        borderColor: colors.border,
        padding: 2,
        flexDirection: "column",
        zIndex,
      }}
    >
      {children}
    </box>
  )
}

function canvasDirectionForKey(name: string): CanvasDirection | undefined {
  switch (name) {
    case "left":
      return "left"
    case "right":
      return "right"
    case "up":
      return "up"
    case "down":
      return "down"
    default:
      return undefined
  }
}

function isStickyNoteSaveKey(
  name: string,
  ctrl: boolean,
  kittyKeyboardSupported: boolean,
): boolean {
  // Raw terminals encode Ctrl+Enter as LF ("linefeed"). Kitty keyboard
  // reports it as a modified Return/KPEnter. Terminals that cannot advertise
  // Kitty support collapse Ctrl+Enter to an indistinguishable plain Return;
  // in that fallback mode, Return is the only reliable save gesture.
  const isEnter = name === "return" || name === "kpenter" || name === "enter"
  return name === "linefeed" || (ctrl && isEnter) || (!kittyKeyboardSupported && isEnter)
}

function userPerceivedCharacterCountLabel(value: string): string {
  try {
    return String(countUserPerceivedCharacters(value))
  } catch {
    return "unavailable"
  }
}

function StickyNoteEditor({
  draft,
  mode,
  width = 32,
  height,
  onTextChange,
}: {
  draft: StickyNoteEditorDraft
  mode: ShellMode
  width?: number
  height?: number
  onTextChange(text: string): boolean
}) {
  const textareaRef = useRef<TextareaRenderable | null>(null)
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
        textareaRef.current.cursorOffset = draft.text.length
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
      if (textareaRef.current && textareaRef.current.cursorOffset === 0 && draft.text.length > 0) {
        textareaRef.current.cursorOffset = draft.text.length
      }
      textareaRef.current?.focus()
    }
  }, [draft.editorId, draft.status, mode])

  const handleContentChange = () => {
    const nextText = textareaRef.current?.plainText ?? ""
    if (syncingTextRef.current) {
      return
    }
    const previousText = textRef.current
    // Update the local mirror before notifying the parent. The parent updates
    // synchronously, so doing this afterward would make the sync effect call
    // setText on every keypress and reset the editor cursor to the beginning.
    textRef.current = nextText
    if (!onTextChange(nextText)) {
      textRef.current = previousText
      syncingTextRef.current = true
      if (textareaRef.current) {
        textareaRef.current.setText(previousText)
        textareaRef.current.cursorOffset = previousText.length
      }
      syncingTextRef.current = false
      setText(previousText)
      return
    }
    setText(nextText)
  }

  return (
    <>
      <textarea
        ref={(textarea) => {
          textareaRef.current = textarea
        }}
        focused={mode === "edit"}
        width={width}
        height={height ?? Math.max(3, lines.length + 2)}
        initialValue={draft.text}
        placeholder="Type a Sticky Note…"
        placeholderColor={colors.muted}
        wrapMode="char"
        backgroundColor={colors.input}
        focusedBackgroundColor={colors.panelActive}
        textColor={colors.text}
        focusedTextColor={colors.text}
        cursorColor={colors.accent}
        onContentChange={handleContentChange}
      />
      <text fg={colors.muted}>
        {userPerceivedCharacterCountLabel(text)} characters · {lines.length} wrapped line{lines.length === 1 ? "" : "s"}
      </text>
    </>
  )
}

function StickyNoteCard({
  note,
  selected = false,
  claimed = false,
  left,
  top,
}: {
  note: StickyNote
  selected?: boolean
  claimed?: boolean
  left?: number
  top?: number
}) {
  const positioned = left !== undefined && top !== undefined
  return (
    <box
      style={{
        width: CANVAS_STICKY_NOTE_CARD_WIDTH,
        height: CANVAS_STICKY_NOTE_CARD_HEIGHT,
        ...(positioned
          ? { position: "absolute" as const, left, top, zIndex: selected ? CANVAS_MAX_COORDINATE + 1 : note.stackingOrder + 1 }
          : {}),
        backgroundColor: selected ? colors.accent : colors.stickyNote,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <text fg={selected ? colors.accentInk : colors.text}>
        {selected ? "› Sticky Note" : claimed ? "✎ Sticky Note" : "Sticky Note"}
      </text>
      <text
        fg={selected ? colors.accentInk : colors.text}
        wrapMode="word"
        overflow="hidden"
        width={CANVAS_STICKY_NOTE_CARD_WIDTH - 2}
        height={CANVAS_STICKY_NOTE_CARD_HEIGHT - 3}
      >
        {note.text.trim().length > 0 ? note.text : " "}
      </text>
    </box>
  )
}

function ShellForm({
  definition,
  notice,
  pending,
  initialKeyToIgnore,
  onCancel,
  onEdit,
  onSubmit,
}: {
  definition: FormDefinition
  notice: ShellNotice | null
  pending: boolean
  initialKeyToIgnore: string | null
  onCancel: () => void
  onEdit: () => void
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
    if (key.name === "up") {
      focusField(focusedIndexRef.current - 1)
      return
    }
    if (key.name === "down" || key.name === "tab") {
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
          width: SHELL_PANEL_WIDTH,
          height: 22,
          backgroundColor: colors.panel,
          border: true,
          borderStyle: "single",
          borderColor: colors.border,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.accentStrong}>{definition.title}</text>
        <text fg={colors.muted}>{definition.description}</text>
        {definition.warning ? <text fg={colors.warning}>{definition.warning}</text> : null}
        <box style={{ marginTop: 1, flexDirection: "column" }}>
          {definition.fields.map((field, index) => (
          <box key={field.id} style={{ width: "100%", flexDirection: "row" }}>
            <text fg={focusedIndex === index ? colors.accentStrong : colors.muted} style={{ width: 20 }}>
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
              backgroundColor={colors.input}
              focusedBackgroundColor={field.sensitive ? colors.input : colors.panelActive}
              textColor={field.sensitive ? colors.muted : colors.text}
              focusedTextColor={field.sensitive ? colors.muted : colors.text}
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
                initialKeyToIgnoreRef.current = null

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
                  onEdit()
                  return
                }

                setInputError(null)
                const nextValues = { ...valuesRef.current, [field.id]: value }
                valuesRef.current = nextValues
                setValues(nextValues)
                onEdit()
              }}
              onSubmit={() => {
                if (initialKeyToIgnoreRef.current === "return") {
                  initialKeyToIgnoreRef.current = null
                  return
                }
                onSubmit(valuesRef.current)
              }}
            />
          </box>
          ))}
        </box>
        {pending ? <text fg={colors.loading}>Contacting the Tuiscrib Service…</text> : null}
        {inputError ? <text fg={colors.error}>Error: {inputError}</text> : null}
        {notice?.kind === "error" ? (
          <box style={{ width: "100%", height: 1, backgroundColor: colors.dangerSurface, paddingX: 1 }}>
            <text fg={colors.error}>Error: {notice.message}</text>
          </box>
        ) : null}
        <text fg={colors.muted}>↑↓ fields · Enter submit · Escape cancel</text>
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
  heroTitle,
  title,
  description,
  items,
  selectedIndex,
  status,
  statusColor,
  error,
  canGoBack = true,
  navigationHint,
}: {
  heroTitle?: string
  title: string
  description: string
  items: ShellMenuItem[]
  selectedIndex: number
  status: string
  statusColor?: string
  error?: string
  canGoBack?: boolean
  navigationHint?: string
}) {
  const selectedItem = items[selectedIndex]
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
          width: SHELL_PANEL_WIDTH,
          height: SHELL_MENU_PANEL_HEIGHT,
          backgroundColor: colors.panel,
          border: true,
          borderStyle: "single",
          borderColor: colors.border,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
          {heroTitle ? (
            <box style={{ width: "100%", alignItems: "center", marginBottom: 1 }}>
              <text fg={colors.accentStrong} attributes={menuTitleAttributes}>{heroTitle}</text>
            </box>
          ) : null}
          <box style={{ width: "100%", alignItems: "center" }}>
            <text fg={colors.accentStrong}>{title}</text>
          </box>
          <text fg={colors.muted}>{description}</text>
          {items.map((item, index) => (
            <MenuRow
              key={item.id}
              label={item.label}
              selected={index === selectedIndex}
              tone={item.id === "delete" ? "danger" : "default"}
            />
          ))}
          {selectedItem ? <text fg={colors.subtle}>{selectedItem.description}</text> : null}
        </box>
        <box style={{ flexDirection: "column", flexShrink: 0 }}>
          {error ? <text fg={colors.error}>Error: {error}</text> : null}
          <text fg={statusColor ?? colors.muted}>{status}</text>
          <text fg={colors.muted}>
            {navigationHint ?? (
              canGoBack ? "↑↓ choose · Enter select · Esc back" : "↑↓ choose · Enter select"
            )}
          </text>
        </box>
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
          width: SHELL_PANEL_WIDTH,
          height: SHELL_HELP_PANEL_HEIGHT,
          backgroundColor: colors.panel,
          border: true,
          borderStyle: "single",
          borderColor: colors.border,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.accentStrong}>Keyboard help</text>
        <text fg={colors.text}>Arrows navigate · Enter acts · Space opens actions.</text>
        <text fg={colors.text}>Tab switches Navigate and Select.</text>
        <text fg={colors.muted}>Canvas: Enter add or edit · Info, Move, Delete live in Actions.</text>
        <text fg={colors.muted}>Editor: Ctrl+Enter save · Escape cancel.</text>
        <text fg={colors.muted}>Forms: ↑↓ fields · Enter submit · Escape cancel.</text>
        <text fg={colors.muted}>Ctrl+C quit · Escape close or go back.</text>
        <text fg={colors.accent}>Escape close</text>
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
          borderColor: colors.borderStrong,
          backgroundColor: colors.panel,
          padding: 2,
          flexDirection: "column",
        }}
      >
        <text fg={colors.accentStrong}>Resize required</text>
        <text fg={colors.text}>
          Tuiscrib needs at least {MIN_TERMINAL_WIDTH} by {MIN_TERMINAL_HEIGHT} cells.
        </text>
        <text fg={colors.muted}>Current terminal: {width} by {height}</text>
        <text fg={colors.muted}>Resize the terminal, then continue.</text>
      </box>
    </box>
  )
}
