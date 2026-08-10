import { randomBytes } from "node:crypto"

import {
  boardCommandErrorSchema,
  boardCommandSchema,
  boardIdentifierSchema,
  boardOpenReadyResponseSchema,
  boardSnapshotSchema,
  STICKY_NOTE_TEXT_LIMIT_ERROR,
  stickyNoteCreationClaimGrantedSchema,
  stickyNoteCreatedSchema,
  stickyNoteTextSchema,
  serviceErrorSchema,
  type BoardCommand,
  type BoardSnapshot,
  type BoardOpenReadyResponse,
  type ServiceError,
} from "@tuiscrib/contracts"
import type {
  CreateStickyNoteResult,
  OpenBoardRecord,
  Persistence,
  StickyNoteRecord,
  TerminalSessionAuthentication,
} from "@tuiscrib/persistence"

import {
  createAuthenticationService,
  type AuthPersistence,
} from "./auth.ts"
import type { BoardUser } from "./boards.ts"

const BOARD_COLLABORATION_PATH = /^\/boards\/([^/]+)\/collaboration$/

export type BoardCollaborationPersistence = Pick<Persistence, "openBoard"> &
  Partial<Pick<
    Persistence,
    | "createStickyNote"
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

export type BoardCollaborationOptions = {
  persistence: BoardCollaborationPersistence
  clock?: () => Date
  stickyNoteIdGenerator?: () => string
  sessionAuthenticator?: (
    credential: string | null,
  ) => Promise<TerminalSessionAuthentication | undefined>
}

export function createBoardCollaboration(
  options: BoardCollaborationOptions,
): BoardCollaboration {
  const clock = options.clock ?? (() => new Date())
  const authenticate = options.sessionAuthenticator ?? createSessionAuthenticator(options, clock)
  const stickyNoteIdGenerator = options.stickyNoteIdGenerator ?? defaultStickyNoteIdGenerator
  const presenceByBoard = new Map<string, BoardPresenceState>()
  const creationClaimsById = new Map<string, StickyNoteCreationClaim>()
  const creationClaimIdByKey = new Map<string, string>()

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

      let authentication: Awaited<ReturnType<NonNullable<typeof authenticate>>>
      try {
        authentication = await authenticate(readBearerCredential(request))
      } catch {
        return serviceErrorResponse(503, { error: "service unavailable" })
      }

      if (!authentication || "status" in authentication) {
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
        return serviceErrorResponse(authorized.status, authorized.error)
      }

      const upgraded = server.upgrade(request, {
        data: {
          boardId,
          board: authorized.board,
          user: authentication.user,
          connectionId: crypto.randomUUID(),
        },
      })
      return upgraded ? undefined : serviceErrorResponse(400, { error: "WebSocket upgrade failed." })
    },

    websocket: {
      data: {} as BoardWebSocketData,
      open(socket) {
        connect(socket)
      },
      close(socket) {
        disconnect(socket)
      },
      message(socket, message) {
        void handleCommand(socket, message)
      },
    },
  }

  function connect(socket: BoardWebSocket): void {
    const { boardId, board, user, connectionId } = socket.data
    const connection: ActiveConnection = {
      id: connectionId,
      boardId,
      board,
      user,
      socket,
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

    sendSnapshot(connection, state)
    broadcastSnapshot(state, connection.id)
  }

  function disconnect(socket: BoardWebSocket): void {
    const { boardId, connectionId, user } = socket.data
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
      stickyNotes: connection.board.stickyNotes ?? [],
    })
  }

  function sendSnapshot(connection: ActiveConnection, state: BoardPresenceState): void {
    connection.socket.send(JSON.stringify(buildSnapshot(connection, state)))
  }

  function broadcastSnapshot(state: BoardPresenceState, excludedConnectionId?: string): void {
    for (const connection of state.connections.values()) {
      if (connection.id !== excludedConnectionId) {
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

    try {
      switch (parsed.data.type) {
        case "begin_sticky_note":
          beginStickyNote(socket, parsed.data)
          return
        case "publish_sticky_note":
          await publishStickyNote(socket, parsed.data)
          return
        case "release_sticky_note_creation":
          releaseStickyNoteCreation(socket, parsed.data.claimId, parsed.data.provisionalId)
          return
      }
    } catch {
      sendCommandError(socket, "sticky_note_rejected", "Sticky Note creation was rejected.")
    }
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

  function setActivity(
    socket: BoardWebSocket,
    activity: "viewing" | "creating" | "editing" | "moving",
  ): void {
    const state = presenceByBoard.get(socket.data.boardId)
    const member = state?.members.get(socket.data.user.id)
    if (!member) {
      return
    }
    member.activityByConnection.set(socket.data.connectionId, activity)
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
      stickyNotes.sort((left, right) =>
        left.stackingOrder - right.stackingOrder || left.id.localeCompare(right.id))
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
      connection.socket.send(serialized)
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

  function sendCommandError(
    socket: BoardWebSocket,
    code: "invalid_command" | "creation_claim_unavailable" | "invalid_creation_claim" | "empty_sticky_note" | "sticky_note_text_limit" | "sticky_note_capacity" | "sticky_note_rejected" | "revision_conflict",
    error: string,
  ): void {
    socket.send(JSON.stringify(boardCommandErrorSchema.parse({
      type: "error",
      code,
      error,
    })))
  }

  return collaboration
}

function isOverLimitStickyNotePublication(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false
  }
  const candidate = payload as { type?: unknown; text?: unknown }
  if (candidate.type !== "publish_sticky_note" || typeof candidate.text !== "string") {
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
