import { randomBytes } from "node:crypto"

import {
  boardCommandErrorSchema,
  boardCommandSchema,
  boardEditClaimSchema,
  boardIdentifierSchema,
  compareStickyNoteStackingOrder,
  boardOpenReadyResponseSchema,
  boardSnapshotSchema,
  STICKY_NOTE_TEXT_LIMIT_ERROR,
  stickyNoteCreationClaimGrantedSchema,
  stickyNoteCreatedSchema,
  stickyNoteEditClaimGrantedSchema,
  stickyNoteMovedSchema,
  stickyNoteRecoloredSchema,
  stickyNoteReorderedSchema,
  stickyNoteUpdatedSchema,
  stickyNoteTextSchema,
  serviceErrorSchema,
  type BoardCommand,
  type BoardEditClaim,
  type BoardSnapshot,
  type BoardOpenReadyResponse,
  type ServiceError,
} from "@tuiscrib/contracts"
import type {
  CreateStickyNoteResult,
  MoveStickyNoteResult,
  OpenBoardRecord,
  Persistence,
  RecolorStickyNoteResult,
  ReorderStickyNoteResult,
  StickyNoteRecord,
  TerminalSessionAuthentication,
  UpdateStickyNoteTextResult,
} from "@tuiscrib/persistence"

import {
  createAuthenticationService,
  hashCredential,
  TERMINAL_SESSION_INACTIVITY_MS,
  type AuthPersistence,
} from "./auth.ts"
import type { BoardUser } from "./boards.ts"

const BOARD_COLLABORATION_PATH = /^\/boards\/([^/]+)\/collaboration$/
export const EDIT_CLAIM_GRACE_MS = 30_000
export const MOVING_PRESENCE_DURATION_MS = 500

export type BoardCollaborationScheduler = {
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

export type BoardCollaborationPersistence = Pick<Persistence, "openBoard"> &
  Partial<Pick<
    Persistence,
    | "createStickyNote"
    | "updateStickyNoteText"
    | "recolorStickyNote"
    | "reorderStickyNote"
    | "moveStickyNote"
    | "findUserByUsername"
    | "registerUser"
    | "createTerminalSession"
    | "authenticateTerminalSession"
  >>

export type BoardOpenOperationResult =
  | { kind: "success"; board: OpenBoardRecord }
  | { kind: "failure"; status: 404 | 503; error: ServiceError }

export type BoardWebSocketData = {
  boardId: string
  board: OpenBoardRecord
  user: BoardUser
  connectionId: string
  /** Only the one-way credential hash is retained for heartbeat re-authentication. */
  credentialHash: string
}

export type BoardWebSocket = Bun.ServerWebSocket<BoardWebSocketData>

export type BoardCollaboration = {
  openBoard(user: BoardUser, publicId: string): Promise<BoardOpenOperationResult>
  handleUpgrade(
    request: Request,
    server: Bun.Server<BoardWebSocketData>,
  ): Promise<Response | undefined | null> | Response | undefined | null
  websocket: Bun.WebSocketHandler<BoardWebSocketData>
}

type ActiveConnection = {
  id: string
  boardId: string
  board: OpenBoardRecord
  user: BoardUser
  socket: BoardWebSocket
  ready: boolean
}

type BoardPresenceState = {
  connections: Map<string, ActiveConnection>
  members: Map<number, {
    username: string
    connections: Set<string>
    activityByConnection: Map<string, "viewing" | "creating" | "editing" | "moving">
  }>
}

type StickyNoteCreationClaim = {
  claimId: string
  boardId: string
  connectionId: string
  provisionalId: string
  position: { x: number; y: number }
  color: "amber" | "blue" | "cyan" | "green" | "magenta" | "red" | "violet" | "yellow"
  status: "creating" | "publishing" | "editing"
  releaseRequested?: boolean
  stickyNoteId?: string
}

type StickyNoteEditClaim = {
  claimId: string
  boardId: string
  ownerSessionKey: string
  holder: BoardUser
  connectionId: string | null
  stickyNoteId: string
  status: "editing" | "publishing"
  connectionState: "connected" | "disconnected"
  graceHandle: unknown | null
  graceToken: number
  expiresAtMs: number | null
  expired: boolean
  invalidated: boolean
  releaseRequested?: boolean
}

export type BoardCollaborationOptions = {
  persistence: BoardCollaborationPersistence
  clock?: () => Date
  scheduler?: BoardCollaborationScheduler
  stickyNoteIdGenerator?: () => string
  sessionAuthenticator?: (
    credential: string | null,
  ) => Promise<TerminalSessionAuthentication | undefined>
  sessionActivityAuthenticator?: (
    credentialHash: string,
  ) => Promise<TerminalSessionAuthentication | undefined>
}

export function createBoardCollaboration(
  options: BoardCollaborationOptions,
): BoardCollaboration {
  const clock = options.clock ?? (() => new Date())
  const scheduler = options.scheduler ?? defaultBoardCollaborationScheduler
  const authenticate = options.sessionAuthenticator ?? createSessionAuthenticator(options, clock)
  const authenticateActivity = options.sessionActivityAuthenticator ??
    createSessionActivityAuthenticator(options, clock)
  const stickyNoteIdGenerator = options.stickyNoteIdGenerator ?? defaultStickyNoteIdGenerator
  const presenceByBoard = new Map<string, BoardPresenceState>()
  const creationClaimsById = new Map<string, StickyNoteCreationClaim>()
  const creationClaimIdByKey = new Map<string, string>()
  const editClaimsById = new Map<string, StickyNoteEditClaim>()
  const editClaimIdByKey = new Map<string, string>()
  const mutationTailByBoard = new Map<string, Promise<void>>()
  const movementPresenceTimersByConnection = new Map<string, {
    boardId: string
    token: number
    handle: unknown
  }>()
  let movementPresenceToken = 0

  const collaboration: BoardCollaboration = {
    async openBoard(user, publicId) {
      if (!boardIdentifierSchema.safeParse(publicId).success) {
        return boardNotFound()
      }

      const board = await options.persistence.openBoard({
        userId: user.id,
        publicId,
      })
      return board ? { kind: "success", board } : boardNotFound()
    },

    async handleUpgrade(request, server) {
      const boardId = getBoardIdFromRequest(request)
      if (boardId === null || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return null
      }

      if (!authenticate) {
        return serviceErrorResponse(503, { error: "service unavailable" })
      }

      const credential = readBearerCredential(request)
      let authentication: Awaited<ReturnType<NonNullable<typeof authenticate>>>
      try {
        authentication = await authenticate(credential)
      } catch {
        return serviceErrorResponse(503, { error: "service unavailable" })
      }

      if (!authentication || "status" in authentication) {
        if (credential) {
          releaseClaimsForSession(hashCredential(credential))
        }
        return serviceErrorResponse(401, {
          error: "Your Terminal Session is invalid. Sign in again.",
          code: "invalid_session",
        })
      }
      if (!credential) {
        return serviceErrorResponse(401, {
          error: "Your Terminal Session is invalid. Sign in again.",
          code: "invalid_session",
        })
      }

      let authorized: BoardOpenOperationResult
      try {
        authorized = await collaboration.openBoard(authentication.user, boardId)
      } catch {
        return serviceErrorResponse(503, { error: "service unavailable" })
      }
      if (authorized.kind === "failure") {
        releaseClaimsForSession(hashCredential(credential))
        return serviceErrorResponse(authorized.status, authorized.error)
      }

      const upgraded = server.upgrade(request, {
        data: {
          boardId,
          board: authorized.board,
          user: authentication.user,
          connectionId: crypto.randomUUID(),
          credentialHash: hashCredential(credential),
        },
      })
      return upgraded ? undefined : serviceErrorResponse(400, { error: "WebSocket upgrade failed." })
    },

    websocket: {
      data: {} as BoardWebSocketData,
      open(socket) {
        void connect(socket)
      },
      close(socket) {
        disconnect(socket)
      },
      message(socket, message) {
        void handleCommand(socket, message)
      },
    },
  }

  async function connect(socket: BoardWebSocket): Promise<void> {
    const { boardId, board, user, connectionId } = socket.data
    const connection: ActiveConnection = {
      id: connectionId,
      boardId,
      board,
      user,
      socket,
      ready: false,
    }
    const state = presenceByBoard.get(boardId) ?? {
      connections: new Map<string, ActiveConnection>(),
      members: new Map<number, {
        username: string
        connections: Set<string>
        activityByConnection: Map<string, "viewing" | "creating" | "editing" | "moving">
      }>(),
    }
    const member = state.members.get(user.id) ?? {
      username: user.username,
      connections: new Set<string>(),
      activityByConnection: new Map(),
    }

    state.connections.set(connection.id, connection)
    member.connections.add(connection.id)
    member.activityByConnection.set(connection.id, "viewing")
    state.members.set(user.id, member)
    presenceByBoard.set(boardId, state)

    let refreshedBoardPromise: Promise<OpenBoardRecord | null>
    try {
      refreshedBoardPromise = options.persistence.openBoard({
        userId: user.id,
        publicId: boardId,
      })
    } catch {
      disconnect(socket, "authorization_lost")
      socket.close()
      return
    }

    let refreshedBoard: OpenBoardRecord | null
    try {
      refreshedBoard = await refreshedBoardPromise
    } catch {
      disconnect(socket, "authorization_lost")
      socket.close()
      return
    }
    if (
      refreshedBoard === null ||
      state.connections.get(connection.id) !== connection
    ) {
      disconnect(socket, "authorization_lost")
      socket.close()
      return
    }

    if (refreshedBoard.revision >= connection.board.revision) {
      connection.board = refreshedBoard
    }
    connection.ready = true
    sendSnapshot(connection, state)
    broadcastSnapshot(state, connection.id)
  }

  function disconnect(
    socket: BoardWebSocket,
    reason: "transient" | "authorization_lost" = "transient",
  ): void {
    const { boardId, connectionId, user } = socket.data
    cancelMovementPresenceTimer(connectionId)
    const state = presenceByBoard.get(boardId)
    if (!state || !state.connections.delete(connectionId)) {
      return
    }

    const member = state.members.get(user.id)
    if (member) {
      member.connections.delete(connectionId)
      member.activityByConnection.delete(connectionId)
      if (member.connections.size === 0) {
        state.members.delete(user.id)
      }
    }

    for (const claim of creationClaimsById.values()) {
      if (claim.connectionId === connectionId) {
        removeCreationClaim(claim)
      }
    }
    for (const claim of editClaimsById.values()) {
      if (claim.connectionId === connectionId) {
        if (reason === "authorization_lost") {
          removeEditClaim(claim)
        } else {
          detachEditClaim(claim)
        }
      }
    }

    if (state.connections.size === 0) {
      presenceByBoard.delete(boardId)
      return
    }
    broadcastSnapshot(state)
  }

  function buildSnapshot(connection: ActiveConnection, state: BoardPresenceState): BoardSnapshot {
    const presence = [...state.members.values()]
      .map((member) => ({
        member: { username: member.username },
        activity: activityForMember(member),
      }))
      .sort((left, right) => left.member.username < right.member.username ? -1 : 1)

    return boardSnapshotSchema.parse({
      type: "snapshot",
      board: connection.board.board,
      revision: connection.board.revision,
      presence,
      editClaims: editClaimsForBoard(connection.boardId),
      stickyNotes: connection.board.stickyNotes ?? [],
    })
  }

  function sendSnapshot(connection: ActiveConnection, state: BoardPresenceState): void {
    connection.socket.send(JSON.stringify(buildSnapshot(connection, state)))
  }

  function broadcastSnapshot(state: BoardPresenceState, excludedConnectionId?: string): void {
    for (const connection of state.connections.values()) {
      if (connection.id !== excludedConnectionId && connection.ready) {
        sendSnapshot(connection, state)
      }
    }
  }

  async function handleCommand(socket: BoardWebSocket, rawMessage: unknown): Promise<void> {
    let payload: unknown
    try {
      payload = JSON.parse(decodeSocketMessage(rawMessage))
    } catch {
      sendCommandError(socket, "invalid_command", "The Board command was invalid.")
      return
    }

    const parsed = boardCommandSchema.safeParse(payload)
    if (!parsed.success) {
      if (isOverLimitStickyNotePublication(payload)) {
        sendCommandError(socket, "sticky_note_text_limit", STICKY_NOTE_TEXT_LIMIT_ERROR)
        return
      }
      sendCommandError(socket, "invalid_command", "The Board command was invalid.")
      return
    }

    const state = presenceByBoard.get(socket.data.boardId)
    const connection = state?.connections.get(socket.data.connectionId)
    if (!connection?.ready) {
      return
    }

    try {
      switch (parsed.data.type) {
        case "heartbeat":
          await refreshHeartbeat(socket)
          return
        case "begin_sticky_note":
          beginStickyNote(socket, parsed.data)
          return
        case "publish_sticky_note":
          await publishStickyNote(socket, parsed.data)
          return
        case "release_sticky_note_creation":
          releaseStickyNoteCreation(socket, parsed.data.claimId, parsed.data.provisionalId)
          return
        case "begin_sticky_note_edit":
          beginStickyNoteEdit(socket, parsed.data.stickyNoteId)
          return
        case "publish_sticky_note_edit":
          await publishStickyNoteEdit(socket, parsed.data)
          return
        case "release_sticky_note_edit":
          releaseStickyNoteEdit(socket, parsed.data.claimId, parsed.data.stickyNoteId)
          return
        case "recolor_sticky_note":
          await runBoardMutation(
            socket.data.boardId,
            () => recolorStickyNote(
              socket,
              parsed.data as Extract<BoardCommand, { type: "recolor_sticky_note" }>,
            ),
          )
          return
        case "reorder_sticky_note":
          await runBoardMutation(
            socket.data.boardId,
            () => reorderStickyNote(
              socket,
              parsed.data as Extract<BoardCommand, { type: "reorder_sticky_note" }>,
            ),
          )
          return
        case "move_sticky_note":
          await runBoardMutation(
            socket.data.boardId,
            () => moveStickyNote(
              socket,
              parsed.data as Extract<BoardCommand, { type: "move_sticky_note" }>,
            ),
          )
          return
      }
    } catch {
      const rejectedMessage = parsed.data.type === "recolor_sticky_note"
        ? "Sticky Note recoloring was rejected."
        : parsed.data.type === "reorder_sticky_note"
        ? "Sticky Note Stacking Order change was rejected."
        : parsed.data.type === "move_sticky_note"
        ? "Sticky Note Position change was rejected."
        : parsed.data.type === "begin_sticky_note_edit" ||
        parsed.data.type === "publish_sticky_note_edit" ||
        parsed.data.type === "release_sticky_note_edit"
        ? "Sticky Note editing was rejected."
        : "Sticky Note creation was rejected."
      sendCommandError(socket, "sticky_note_rejected", rejectedMessage)
    }
  }

  async function refreshHeartbeat(socket: BoardWebSocket): Promise<void> {
    if (!authenticateActivity) {
      closeForAuthorizationLoss(socket)
      return
    }
    const credentialHash = socket.data.credentialHash
    if (!credentialHash) {
      closeForAuthorizationLoss(socket)
      return
    }
    try {
      const authentication = await authenticateActivity(credentialHash)
      if (!authentication || "status" in authentication) {
        closeForAuthorizationLoss(socket)
      }
    } catch {
      closeForAuthorizationLoss(socket)
    }
  }

  function closeForAuthorizationLoss(socket: BoardWebSocket): void {
    disconnect(socket, "authorization_lost")
    socket.close()
  }

  function beginStickyNote(
    socket: BoardWebSocket,
    command: Extract<BoardCommand, { type: "begin_sticky_note" }>,
  ): void {
    if (typeof options.persistence.createStickyNote !== "function") {
      sendCommandError(socket, "sticky_note_rejected", "Sticky Note creation is unavailable.")
      return
    }

    const key = creationClaimKey(socket.data.boardId, command.provisionalId)
    const existingClaimId = creationClaimIdByKey.get(key)
    if (existingClaimId) {
      const existingClaim = creationClaimsById.get(existingClaimId)
      if (existingClaim?.connectionId === socket.data.connectionId) {
        sendClaimAcknowledgement(socket, existingClaim)
      } else {
        sendCommandError(
          socket,
          "creation_claim_unavailable",
          "Another Terminal Session already holds this creation authority.",
        )
      }
      return
    }

    const claim: StickyNoteCreationClaim = {
      claimId: crypto.randomUUID(),
      boardId: socket.data.boardId,
      connectionId: socket.data.connectionId,
      provisionalId: command.provisionalId,
      position: command.position,
      color: command.color,
      status: "creating",
    }
    creationClaimsById.set(claim.claimId, claim)
    creationClaimIdByKey.set(key, claim.claimId)
    setActivity(socket, "creating")

    const state = presenceByBoard.get(socket.data.boardId)
    if (state) {
      broadcastSnapshot(state)
    }
    sendClaimAcknowledgement(socket, claim)
  }

  async function publishStickyNote(
    socket: BoardWebSocket,
    command: Extract<BoardCommand, { type: "publish_sticky_note" }>,
  ): Promise<void> {
    const claim = creationClaimsById.get(command.claimId)
    if (
      !claim ||
      claim.connectionId !== socket.data.connectionId ||
      claim.boardId !== socket.data.boardId ||
      claim.provisionalId !== command.provisionalId ||
      claim.status !== "creating"
    ) {
      sendCommandError(
        socket,
        "invalid_creation_claim",
        "Sticky Note creation authority is invalid or already used.",
      )
      return
    }

    const createStickyNote = options.persistence.createStickyNote
    if (typeof createStickyNote !== "function") {
      sendCommandError(socket, "sticky_note_rejected", "Sticky Note creation is unavailable.")
      return
    }

    claim.status = "publishing"
    try {
      const result = await createStickyNote({
        publicId: stickyNoteIdGenerator(),
        boardId: socket.data.boardId,
        userId: socket.data.user.id,
        text: command.text,
        position: claim.position,
        color: claim.color,
        now: clock(),
      })
      if (result.kind !== "created") {
        if (claim.releaseRequested) {
          removeCreationClaim(claim)
          setActivity(socket, "viewing")
          broadcastPresenceForBoard(socket.data.boardId)
        } else {
          claim.status = "creating"
        }
        sendPersistenceError(socket, result)
        return
      }

      const event = stickyNoteCreatedSchema.parse({
        type: "sticky_note_created",
        revision: result.revision,
        provisionalId: claim.provisionalId,
        stickyNote: result.stickyNote,
      })
      const releaseRequested = claim.releaseRequested === true
      if (releaseRequested) {
        removeCreationClaim(claim)
      } else {
        claim.status = "editing"
        claim.stickyNoteId = result.stickyNote.id
      }

      const state = presenceByBoard.get(socket.data.boardId)
      if (!state) {
        return
      }
      setActivity(socket, releaseRequested ? "viewing" : "editing")
      applyCreatedNote(state, result.stickyNote, result.revision)
      broadcastStickyNoteCreated(state, event)
      broadcastSnapshot(state)
    } catch (error) {
      if (claim.status === "publishing") {
        if (claim.releaseRequested) {
          removeCreationClaim(claim)
          setActivity(socket, "viewing")
          broadcastPresenceForBoard(socket.data.boardId)
        } else {
          claim.status = "creating"
        }
      }
      throw error
    }
  }

  function releaseStickyNoteCreation(
    socket: BoardWebSocket,
    claimId: string,
    provisionalId: string,
  ): void {
    const claim = creationClaimsById.get(claimId)
    if (
      !claim ||
      claim.connectionId !== socket.data.connectionId ||
      claim.boardId !== socket.data.boardId ||
      claim.provisionalId !== provisionalId
    ) {
      sendCommandError(
        socket,
        "invalid_creation_claim",
        "Sticky Note creation authority is invalid or already used.",
      )
      return
    }

    if (claim.status === "publishing") {
      claim.releaseRequested = true
      setActivity(socket, "viewing")
      broadcastPresenceForBoard(socket.data.boardId)
      return
    }

    removeCreationClaim(claim)
    setActivity(socket, "viewing")
    broadcastPresenceForBoard(socket.data.boardId)
  }

  function beginStickyNoteEdit(socket: BoardWebSocket, stickyNoteId: string): void {
    if (typeof options.persistence.updateStickyNoteText !== "function") {
      sendCommandError(socket, "sticky_note_rejected", "Sticky Note editing is unavailable.")
      return
    }

    const state = presenceByBoard.get(socket.data.boardId)
    const connection = state?.connections.get(socket.data.connectionId)
    const note = connection?.board.stickyNotes?.find((currentNote) => currentNote.id === stickyNoteId)
    if (!note) {
      sendCommandError(socket, "sticky_note_rejected", "Sticky Note was not found.")
      return
    }

    const key = editClaimKey(socket.data.boardId, stickyNoteId)
    const existingClaimId = editClaimIdByKey.get(key)
    const existingClaim = existingClaimId
      ? editClaimsById.get(existingClaimId)
      : undefined
    if (existingClaim && claimHasExpired(existingClaim)) {
      removeEditClaim(existingClaim)
    }
    const currentClaimId = editClaimIdByKey.get(key)
    const currentClaim = currentClaimId ? editClaimsById.get(currentClaimId) : undefined
    if (currentClaim) {
      if (
        currentClaim.ownerSessionKey === socket.data.credentialHash &&
        currentClaim.status === "editing"
      ) {
        if (
          currentClaim.connectionId !== null &&
          currentClaim.connectionId !== socket.data.connectionId
        ) {
          setActivityForConnection(
            socket.data.boardId,
            currentClaim.connectionId,
            "viewing",
          )
        }
        reattachEditClaim(currentClaim, socket)
        setActivity(socket, "editing")
        broadcastPresenceForBoard(socket.data.boardId)
        sendEditClaimAcknowledgement(socket, currentClaim, note)
        return
      }

      sendCommandError(
        socket,
        "edit_claim_unavailable",
        "Another Terminal Session already holds this Edit Claim.",
        {
          claimHolder: { username: currentClaim.holder.username },
          claimConnection: currentClaim.connectionState,
          ...(currentClaim.expiresAtMs === null
            ? {}
            : { claimExpiresAt: new Date(currentClaim.expiresAtMs).toISOString() }),
        },
      )
      return
    }

    const claim: StickyNoteEditClaim = {
      claimId: crypto.randomUUID(),
      boardId: socket.data.boardId,
      ownerSessionKey: socket.data.credentialHash,
      holder: socket.data.user,
      connectionId: socket.data.connectionId,
      stickyNoteId,
      status: "editing",
      connectionState: "connected",
      graceHandle: null,
      graceToken: 0,
      expiresAtMs: null,
      expired: false,
      invalidated: false,
    }
    editClaimsById.set(claim.claimId, claim)
    editClaimIdByKey.set(key, claim.claimId)
    setActivity(socket, "editing")
    broadcastPresenceForBoard(socket.data.boardId)
    sendEditClaimAcknowledgement(socket, claim, note)
  }

  async function publishStickyNoteEdit(
    socket: BoardWebSocket,
    command: Extract<BoardCommand, { type: "publish_sticky_note_edit" }>,
  ): Promise<void> {
    const claim = editClaimsById.get(command.claimId)
    if (
      !claim ||
      claim.connectionId !== socket.data.connectionId ||
      claim.connectionState !== "connected" ||
      claim.ownerSessionKey !== socket.data.credentialHash ||
      claim.invalidated ||
      claim.expired ||
      claim.boardId !== socket.data.boardId ||
      claim.stickyNoteId !== command.stickyNoteId ||
      claim.status !== "editing"
    ) {
      sendCommandError(
        socket,
        "invalid_edit_claim",
        "Sticky Note Edit Claim is invalid or already publishing.",
      )
      return
    }

    const updateStickyNoteText = options.persistence.updateStickyNoteText
    if (typeof updateStickyNoteText !== "function") {
      sendCommandError(socket, "sticky_note_rejected", "Sticky Note editing is unavailable.")
      return
    }

    claim.status = "publishing"
    try {
      const result = await updateStickyNoteText({
        boardId: socket.data.boardId,
        stickyNoteId: command.stickyNoteId,
        userId: socket.data.user.id,
        text: command.text,
        expectedTextVersion: command.expectedTextVersion,
        now: clock(),
      })
      if (result.kind === "updated") {
        const event = stickyNoteUpdatedSchema.parse({
          type: "sticky_note_updated",
          revision: result.revision,
          stickyNote: result.stickyNote,
        })
        const releaseRequested = claim.releaseRequested === true ||
          claim.expired ||
          claim.invalidated
        if (releaseRequested) {
          removeEditClaim(claim)
        } else {
          claim.status = "editing"
        }

        const state = presenceByBoard.get(socket.data.boardId)
        if (!state) {
          return
        }
        applyUpdatedNote(state, result.stickyNote, result.revision)
        broadcastStickyNoteUpdated(state, event)
        if (releaseRequested) {
          setActivity(socket, "viewing")
        }
        broadcastSnapshot(state)
        return
      }

      const releaseRequested = claim.releaseRequested === true ||
        claim.expired ||
        claim.invalidated
      if (releaseRequested) {
        removeEditClaim(claim)
      } else {
        claim.status = "editing"
      }

      const state = presenceByBoard.get(socket.data.boardId)
      if (result.kind === "text_version_conflict" && state) {
        applyUpdatedNote(state, result.stickyNote, result.revision)
        broadcastSnapshot(state)
      }
      if (releaseRequested) {
        setActivity(socket, "viewing")
        broadcastPresenceForBoard(socket.data.boardId)
      }
      if (result.kind === "text_version_conflict") {
        sendCommandError(
          socket,
          "text_version_conflict",
          "Sticky Note text changed before this publication. Your local text was replaced with the authoritative text.",
          {
            authoritative: {
              revision: result.revision,
              stickyNote: result.stickyNote,
            },
          },
        )
      } else {
        sendEditPersistenceError(socket, result)
      }
    } catch {
      if (claim.status === "publishing") {
        if (claim.releaseRequested) {
          removeEditClaim(claim)
          setActivity(socket, "viewing")
          broadcastPresenceForBoard(socket.data.boardId)
        } else {
          claim.status = "editing"
        }
      }
      throw new Error("Sticky Note editing was rejected.")
    }
  }

  async function recolorStickyNote(
    socket: BoardWebSocket,
    command: Extract<BoardCommand, { type: "recolor_sticky_note" }>,
  ): Promise<void> {
    const recolorStickyNote = options.persistence.recolorStickyNote
    if (typeof recolorStickyNote !== "function") {
      sendCommandError(socket, "sticky_note_rejected", "Sticky Note recoloring is unavailable.")
      return
    }

    const result = await recolorStickyNote({
      boardId: socket.data.boardId,
      stickyNoteId: command.stickyNoteId,
      userId: socket.data.user.id,
      color: command.color,
    })
    if (result.kind !== "recolored") {
      sendColorPersistenceError(socket, result)
      return
    }

    const event = stickyNoteRecoloredSchema.parse({
      type: "sticky_note_recolored",
      revision: result.revision,
      stickyNote: result.stickyNote,
    })
    const state = presenceByBoard.get(socket.data.boardId)
    if (!state) {
      return
    }
    applyUpdatedNote(state, result.stickyNote, result.revision)
    broadcastStickyNoteRecolored(state, event)
    broadcastSnapshot(state)
  }

  async function reorderStickyNote(
    socket: BoardWebSocket,
    command: Extract<BoardCommand, { type: "reorder_sticky_note" }>,
  ): Promise<void> {
    const reorderStickyNote = options.persistence.reorderStickyNote
    if (typeof reorderStickyNote !== "function") {
      sendCommandError(socket, "sticky_note_rejected", "Sticky Note Stacking Order is unavailable.")
      return
    }

    const result = await reorderStickyNote({
      boardId: socket.data.boardId,
      stickyNoteId: command.stickyNoteId,
      userId: socket.data.user.id,
      direction: command.direction,
    })
    if (result.kind === "at_boundary") {
      sendCommandError(
        socket,
        "stacking_order_boundary",
        command.direction === "raise"
          ? "Sticky Note is already at the front of the Stacking Order."
          : "Sticky Note is already at the back of the Stacking Order.",
        {
          authoritative: {
            revision: result.revision,
            stickyNote: result.stickyNote,
          },
        },
      )
      return
    }
    if (result.kind !== "reordered") {
      sendReorderPersistenceError(socket, result)
      return
    }

    const event = stickyNoteReorderedSchema.parse({
      type: "sticky_note_reordered",
      revision: result.revision,
      stickyNote: result.stickyNote,
      affectedStickyNotes: result.affectedStickyNotes,
    })
    const state = presenceByBoard.get(socket.data.boardId)
    if (!state) {
      return
    }
    applyUpdatedNotes(state, result.affectedStickyNotes ?? [result.stickyNote], result.revision)
    broadcastStickyNoteReordered(state, event)
    broadcastSnapshot(state)
  }

  async function moveStickyNote(
    socket: BoardWebSocket,
    command: Extract<BoardCommand, { type: "move_sticky_note" }>,
  ): Promise<void> {
    const moveStickyNote = options.persistence.moveStickyNote
    if (typeof moveStickyNote !== "function") {
      sendCommandError(socket, "sticky_note_rejected", "Sticky Note Position is unavailable.")
      return
    }

    const result = await moveStickyNote({
      boardId: socket.data.boardId,
      stickyNoteId: command.stickyNoteId,
      userId: socket.data.user.id,
      direction: command.direction,
    })
    if (result.kind === "at_boundary") {
      sendCommandError(
        socket,
        "position_boundary",
        "Sticky Note cannot move beyond the shared coordinate plane.",
        {
          authoritative: {
            revision: result.revision,
            stickyNote: result.stickyNote,
          },
        },
      )
      return
    }
    if (result.kind !== "moved") {
      sendMovePersistenceError(socket, result)
      return
    }

    const event = stickyNoteMovedSchema.parse({
      type: "sticky_note_moved",
      revision: result.revision,
      stickyNote: result.stickyNote,
    })
    const state = presenceByBoard.get(socket.data.boardId)
    if (!state) {
      return
    }
    applyUpdatedNote(state, result.stickyNote, result.revision)
    broadcastStickyNoteMoved(state, event)
    setActivity(socket, "moving")
    broadcastSnapshot(state)
  }

  function releaseStickyNoteEdit(
    socket: BoardWebSocket,
    claimId: string,
    stickyNoteId: string,
  ): void {
    const claim = editClaimsById.get(claimId)
    if (
      !claim ||
      claim.connectionId !== socket.data.connectionId ||
      claim.connectionState !== "connected" ||
      claim.ownerSessionKey !== socket.data.credentialHash ||
      claim.invalidated ||
      claim.boardId !== socket.data.boardId ||
      claim.stickyNoteId !== stickyNoteId
    ) {
      sendCommandError(socket, "invalid_edit_claim", "Sticky Note Edit Claim is invalid or already released.")
      return
    }

    if (claim.status === "publishing") {
      claim.releaseRequested = true
      return
    }

    removeEditClaim(claim)
    setActivity(socket, "viewing")
    broadcastPresenceForBoard(socket.data.boardId)
  }

  function setActivity(
    socket: BoardWebSocket,
    activity: "viewing" | "creating" | "editing" | "moving",
  ): void {
    setActivityForConnection(socket.data.boardId, socket.data.connectionId, activity)
  }

  function setActivityForConnection(
    boardId: string,
    connectionId: string,
    activity: "viewing" | "creating" | "editing" | "moving",
  ): void {
    const state = presenceByBoard.get(boardId)
    const connection = state?.connections.get(connectionId)
    const member = connection ? state?.members.get(connection.user.id) : undefined
    if (!member) {
      return
    }
    cancelMovementPresenceTimer(connectionId)
    member.activityByConnection.set(connectionId, activity)
    if (activity !== "moving") {
      return
    }

    const token = ++movementPresenceToken
    const handle = scheduler.schedule(() => {
      const current = movementPresenceTimersByConnection.get(connectionId)
      if (!current || current.token !== token) {
        return
      }
      movementPresenceTimersByConnection.delete(connectionId)
      const currentState = presenceByBoard.get(boardId)
      const currentConnection = currentState?.connections.get(connectionId)
      const currentMember = currentConnection
        ? currentState?.members.get(currentConnection.user.id)
        : undefined
      if (!currentState || !currentConnection || !currentMember ||
        currentMember.activityByConnection.get(connectionId) !== "moving") {
        return
      }
      currentMember.activityByConnection.set(connectionId, "viewing")
      broadcastPresenceForBoard(boardId)
    }, MOVING_PRESENCE_DURATION_MS)
    movementPresenceTimersByConnection.set(connectionId, { boardId, token, handle })
  }

  function cancelMovementPresenceTimer(connectionId: string): void {
    const timer = movementPresenceTimersByConnection.get(connectionId)
    if (!timer) {
      return
    }
    scheduler.cancel(timer.handle)
    movementPresenceTimersByConnection.delete(connectionId)
  }

  function removeCreationClaim(claim: StickyNoteCreationClaim): void {
    if (creationClaimsById.get(claim.claimId) === claim) {
      creationClaimsById.delete(claim.claimId)
    }
    const key = creationClaimKey(claim.boardId, claim.provisionalId)
    if (creationClaimIdByKey.get(key) === claim.claimId) {
      creationClaimIdByKey.delete(key)
    }
  }

  function removeEditClaim(claim: StickyNoteEditClaim): void {
    if (claim.graceHandle !== null) {
      scheduler.cancel(claim.graceHandle)
      claim.graceHandle = null
    }
    if (editClaimsById.get(claim.claimId) === claim) {
      editClaimsById.delete(claim.claimId)
    }
    const key = editClaimKey(claim.boardId, claim.stickyNoteId)
    if (editClaimIdByKey.get(key) === claim.claimId) {
      editClaimIdByKey.delete(key)
    }
  }

  function detachEditClaim(claim: StickyNoteEditClaim): void {
    if (editClaimsById.get(claim.claimId) !== claim || claim.invalidated) {
      return
    }
    if (claim.graceHandle !== null) {
      scheduler.cancel(claim.graceHandle)
    }
    claim.connectionId = null
    claim.connectionState = "disconnected"
    claim.expiresAtMs = clock().getTime() + EDIT_CLAIM_GRACE_MS
    claim.expired = false
    const graceToken = ++claim.graceToken
    claim.graceHandle = scheduler.schedule(() => {
      if (
        editClaimsById.get(claim.claimId) !== claim ||
        claim.graceToken !== graceToken ||
        claim.connectionState !== "disconnected"
      ) {
        return
      }
      claim.graceHandle = null
      claim.expired = true
      if (claim.status === "publishing") {
        return
      }
      removeEditClaim(claim)
      broadcastPresenceForBoard(claim.boardId)
    }, EDIT_CLAIM_GRACE_MS)
  }

  function reattachEditClaim(claim: StickyNoteEditClaim, socket: BoardWebSocket): void {
    if (claim.graceHandle !== null) {
      scheduler.cancel(claim.graceHandle)
      claim.graceHandle = null
    }
    claim.connectionId = socket.data.connectionId
    claim.connectionState = "connected"
    claim.expiresAtMs = null
    claim.expired = false
    claim.graceToken += 1
  }

  function claimHasExpired(claim: StickyNoteEditClaim): boolean {
    if (
      claim.connectionState === "disconnected" &&
      claim.expiresAtMs !== null &&
      clock().getTime() >= claim.expiresAtMs
    ) {
      claim.expired = true
    }
    return claim.expired
  }

  function editClaimsForBoard(boardId: string): BoardEditClaim[] {
    const claims: BoardEditClaim[] = []
    for (const claim of editClaimsById.values()) {
      if (claim.boardId !== boardId) {
        continue
      }
      if (claimHasExpired(claim) && claim.status !== "publishing") {
        removeEditClaim(claim)
        continue
      }
      claims.push(boardEditClaimSchema.parse({
        stickyNoteId: claim.stickyNoteId,
        holder: { username: claim.holder.username },
        status: claim.connectionState,
        ...(claim.expiresAtMs === null
          ? {}
          : { expiresAt: new Date(claim.expiresAtMs).toISOString() }),
      }))
    }
    return claims.sort((left, right) =>
      left.stickyNoteId.localeCompare(right.stickyNoteId) ||
      left.holder.username.localeCompare(right.holder.username),
    )
  }

  function releaseClaimsForSession(sessionKey: string): void {
    const affectedBoards = new Set<string>()
    for (const claim of editClaimsById.values()) {
      if (claim.ownerSessionKey !== sessionKey) {
        continue
      }
      affectedBoards.add(claim.boardId)
      claim.invalidated = true
      removeEditClaim(claim)
    }
    for (const boardId of affectedBoards) {
      broadcastPresenceForBoard(boardId)
    }
  }

  async function runBoardMutation(
    boardId: string,
    mutation: () => Promise<void>,
  ): Promise<void> {
    const previous = mutationTailByBoard.get(boardId) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => turn)
    mutationTailByBoard.set(boardId, tail)

    await previous.catch(() => undefined)
    try {
      await mutation()
    } finally {
      release()
      if (mutationTailByBoard.get(boardId) === tail) {
        mutationTailByBoard.delete(boardId)
      }
    }
  }

  function broadcastPresenceForBoard(boardId: string): void {
    const state = presenceByBoard.get(boardId)
    if (state) {
      broadcastSnapshot(state)
    }
  }

  function applyCreatedNote(
    state: BoardPresenceState,
    note: StickyNoteRecord,
    revision: number,
  ): void {
    for (const connection of state.connections.values()) {
      const stickyNotes = [...(connection.board.stickyNotes ?? [])]
        .filter((currentNote) => currentNote.id !== note.id)
      stickyNotes.push(note)
      stickyNotes.sort(compareStickyNoteStackingOrder)
      connection.board = {
        ...connection.board,
        revision,
        stickyNotes,
      }
    }
  }

  function applyUpdatedNote(
    state: BoardPresenceState,
    note: StickyNoteRecord,
    revision: number,
  ): void {
    applyUpdatedNotes(state, [note], revision)
  }

  function applyUpdatedNotes(
    state: BoardPresenceState,
    notes: readonly StickyNoteRecord[],
    revision: number,
  ): void {
    for (const connection of state.connections.values()) {
      const stickyNotes = [...(connection.board.stickyNotes ?? [])]
      for (const note of notes) {
        const existingIndex = stickyNotes.findIndex((currentNote) => currentNote.id === note.id)
        if (existingIndex === -1) {
          stickyNotes.push(note)
        } else {
          stickyNotes[existingIndex] = note
        }
      }
      stickyNotes.sort(compareStickyNoteStackingOrder)
      connection.board = {
        ...connection.board,
        revision,
        stickyNotes,
      }
    }
  }

  function broadcastStickyNoteCreated(
    state: BoardPresenceState,
    event: ReturnType<typeof stickyNoteCreatedSchema.parse>,
  ): void {
    const serialized = JSON.stringify(event)
    for (const connection of state.connections.values()) {
      if (connection.ready) {
        connection.socket.send(serialized)
      }
    }
  }

  function broadcastStickyNoteUpdated(
    state: BoardPresenceState,
    event: ReturnType<typeof stickyNoteUpdatedSchema.parse>,
  ): void {
    const serialized = JSON.stringify(event)
    for (const connection of state.connections.values()) {
      if (connection.ready) {
        connection.socket.send(serialized)
      }
    }
  }

  function broadcastStickyNoteRecolored(
    state: BoardPresenceState,
    event: ReturnType<typeof stickyNoteRecoloredSchema.parse>,
  ): void {
    const serialized = JSON.stringify(event)
    for (const connection of state.connections.values()) {
      if (connection.ready) {
        connection.socket.send(serialized)
      }
    }
  }

  function broadcastStickyNoteReordered(
    state: BoardPresenceState,
    event: ReturnType<typeof stickyNoteReorderedSchema.parse>,
  ): void {
    const serialized = JSON.stringify(event)
    for (const connection of state.connections.values()) {
      if (connection.ready) {
        connection.socket.send(serialized)
      }
    }
  }

  function broadcastStickyNoteMoved(
    state: BoardPresenceState,
    event: ReturnType<typeof stickyNoteMovedSchema.parse>,
  ): void {
    const serialized = JSON.stringify(event)
    for (const connection of state.connections.values()) {
      if (connection.ready) {
        connection.socket.send(serialized)
      }
    }
  }

  function sendClaimAcknowledgement(
    socket: BoardWebSocket,
    claim: StickyNoteCreationClaim,
  ): void {
    socket.send(JSON.stringify(stickyNoteCreationClaimGrantedSchema.parse({
      type: "sticky_note_creation_claim_granted",
      provisionalId: claim.provisionalId,
      claimId: claim.claimId,
      position: claim.position,
      color: claim.color,
    })))
  }

  function sendEditClaimAcknowledgement(
    socket: BoardWebSocket,
    claim: StickyNoteEditClaim,
    note: StickyNoteRecord,
  ): void {
    socket.send(JSON.stringify(stickyNoteEditClaimGrantedSchema.parse({
      type: "sticky_note_edit_claim_granted",
      stickyNoteId: claim.stickyNoteId,
      claimId: claim.claimId,
      stickyNote: note,
    })))
  }

  function sendPersistenceError(socket: BoardWebSocket, result: CreateStickyNoteResult): void {
    switch (result.kind) {
      case "empty_text":
        sendCommandError(socket, "empty_sticky_note", "A new Sticky Note needs non-empty text.")
        return
      case "board_capacity":
        sendCommandError(socket, "sticky_note_capacity", "This Board cannot hold more Sticky Notes.")
        return
      case "invalid_text":
        sendCommandError(socket, "sticky_note_rejected", "Sticky Note text was rejected.")
        return
      case "not_found":
      case "not_member":
        sendCommandError(socket, "sticky_note_rejected", "Sticky Note creation was rejected.")
        return
      case "created":
        return
    }
  }

  function sendEditPersistenceError(socket: BoardWebSocket, result: UpdateStickyNoteTextResult): void {
    switch (result.kind) {
      case "invalid_text":
        sendCommandError(socket, "sticky_note_rejected", "Sticky Note text was rejected.")
        return
      case "not_found":
      case "not_member":
        sendCommandError(socket, "sticky_note_rejected", "Sticky Note editing was rejected.")
        return
      case "updated":
      case "text_version_conflict":
        return
    }
  }

  function sendColorPersistenceError(socket: BoardWebSocket, result: RecolorStickyNoteResult): void {
    switch (result.kind) {
      case "invalid_color":
        sendCommandError(socket, "sticky_note_rejected", "Sticky Note Color was rejected.")
        return
      case "not_found":
      case "not_member":
        sendCommandError(socket, "sticky_note_rejected", "Sticky Note recoloring was rejected.")
        return
      case "recolored":
        return
    }
  }

  function sendReorderPersistenceError(
    socket: BoardWebSocket,
    result: ReorderStickyNoteResult,
  ): void {
    switch (result.kind) {
      case "not_found":
      case "not_member":
        sendCommandError(socket, "sticky_note_rejected", "Sticky Note Stacking Order change was rejected.")
        return
      case "at_boundary":
      case "reordered":
        return
    }
  }

  function sendMovePersistenceError(
    socket: BoardWebSocket,
    result: MoveStickyNoteResult,
  ): void {
    switch (result.kind) {
      case "invalid_direction":
        sendCommandError(socket, "sticky_note_rejected", "Sticky Note Position change was rejected.")
        return
      case "not_found":
      case "not_member":
        sendCommandError(socket, "sticky_note_rejected", "Sticky Note Position change was rejected.")
        return
      case "at_boundary":
      case "moved":
        return
    }
  }

  function sendCommandError(
    socket: BoardWebSocket,
    code: "invalid_command" | "creation_claim_unavailable" | "invalid_creation_claim" | "edit_claim_unavailable" | "invalid_edit_claim" | "empty_sticky_note" | "sticky_note_text_limit" | "sticky_note_capacity" | "sticky_note_rejected" | "text_version_conflict" | "stacking_order_boundary" | "position_boundary" | "revision_conflict",
    error: string,
    details?: {
      claimHolder?: { username: string }
      claimConnection?: "connected" | "disconnected"
      claimExpiresAt?: string
      authoritative?: { revision: number; stickyNote: StickyNoteRecord }
    },
  ): void {
    socket.send(JSON.stringify(boardCommandErrorSchema.parse({
      type: "error",
      code,
      error,
      ...details,
    })))
  }

  return collaboration
}

function isOverLimitStickyNotePublication(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false
  }
  const candidate = payload as { type?: unknown; text?: unknown }
  if (
    (candidate.type !== "publish_sticky_note" && candidate.type !== "publish_sticky_note_edit") ||
    typeof candidate.text !== "string"
  ) {
    return false
  }

  const parsed = stickyNoteTextSchema.safeParse(candidate.text)
  return !parsed.success && parsed.error.issues.some(
    (issue) => issue.message === STICKY_NOTE_TEXT_LIMIT_ERROR,
  )
}

function activityForMember(member: {
  activityByConnection: Map<string, "viewing" | "creating" | "editing" | "moving">
}): "viewing" | "creating" | "editing" | "moving" {
  for (const activity of ["creating", "editing", "moving", "viewing"] as const) {
    if ([...member.activityByConnection.values()].includes(activity)) {
      return activity
    }
  }
  return "viewing"
}

function creationClaimKey(boardId: string, provisionalId: string): string {
  return `${boardId}:${provisionalId}`
}

function editClaimKey(boardId: string, stickyNoteId: string): string {
  return `${boardId}:${stickyNoteId}`
}

function decodeSocketMessage(message: unknown): string {
  if (typeof message === "string") {
    return message
  }
  if (message instanceof ArrayBuffer) {
    return new TextDecoder().decode(message)
  }
  if (message instanceof Uint8Array) {
    return new TextDecoder().decode(message)
  }
  return String(message)
}

function defaultStickyNoteIdGenerator(): string {
  return randomBytes(16).toString("base64url")
}

export function boardOpenReadyResponse(): BoardOpenReadyResponse {
  return boardOpenReadyResponseSchema.parse({ status: "ready" })
}

function createSessionAuthenticator(
  options: BoardCollaborationOptions,
  clock: () => Date,
): BoardCollaborationOptions["sessionAuthenticator"] {
  const persistence = options.persistence
  if (
    typeof persistence.findUserByUsername !== "function" ||
    typeof persistence.registerUser !== "function" ||
    typeof persistence.createTerminalSession !== "function" ||
    typeof persistence.authenticateTerminalSession !== "function"
  ) {
    return undefined
  }

  const authentication = createAuthenticationService({
    persistence: persistence as AuthPersistence,
    clock,
  })
  return (credential) => authentication.authenticate(credential)
}

function createSessionActivityAuthenticator(
  options: BoardCollaborationOptions,
  clock: () => Date,
): BoardCollaborationOptions["sessionActivityAuthenticator"] {
  const authenticateTerminalSession = options.persistence.authenticateTerminalSession
  if (typeof authenticateTerminalSession !== "function") {
    return undefined
  }

  return (credentialHash) => {
    const now = clock()
    return authenticateTerminalSession({
      credentialHash,
      now,
      expiresAt: new Date(now.getTime() + TERMINAL_SESSION_INACTIVITY_MS),
    })
  }
}

function getBoardIdFromRequest(request: Request): string | null {
  const match = BOARD_COLLABORATION_PATH.exec(new URL(request.url).pathname)
  if (!match?.[1]) {
    return null
  }
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

function readBearerCredential(request: Request): string | null {
  const authorization = request.headers.get("authorization")
  if (!authorization) {
    return null
  }
  const match = /^Bearer ([^\s]+)$/.exec(authorization)
  return match?.[1] ?? null
}

function boardNotFound(): BoardOpenOperationResult {
  return {
    kind: "failure",
    status: 404,
    error: serviceErrorSchema.parse({
      error: "Board Membership was not found.",
      code: "membership_not_found",
    }),
  }
}

function serviceErrorResponse(status: number, error: ServiceError): Response {
  return new Response(JSON.stringify(serviceErrorSchema.parse(error)), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  })
}

const defaultBoardCollaborationScheduler: BoardCollaborationScheduler = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}
