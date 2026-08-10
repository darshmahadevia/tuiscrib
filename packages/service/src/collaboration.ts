import {
  boardIdentifierSchema,
  boardOpenReadyResponseSchema,
  boardSnapshotSchema,
  serviceErrorSchema,
  type BoardSnapshot,
  type BoardOpenReadyResponse,
  type ServiceError,
} from "@tuiscrib/contracts"
import type {
  OpenBoardRecord,
  Persistence,
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
    "findUserByUsername" | "registerUser" | "createTerminalSession" | "authenticateTerminalSession"
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
  members: Map<number, { username: string; connections: Set<string> }>
}

export type BoardCollaborationOptions = {
  persistence: BoardCollaborationPersistence
  clock?: () => Date
  sessionAuthenticator?: (
    credential: string | null,
  ) => Promise<TerminalSessionAuthentication | undefined>
}

export function createBoardCollaboration(
  options: BoardCollaborationOptions,
): BoardCollaboration {
  const clock = options.clock ?? (() => new Date())
  const authenticate = options.sessionAuthenticator ?? createSessionAuthenticator(options, clock)
  const presenceByBoard = new Map<string, BoardPresenceState>()

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
      message() {
        // Board commands are introduced by later collaboration slices.
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
      members: new Map<number, { username: string; connections: Set<string> }>(),
    }
    const member = state.members.get(user.id) ?? {
      username: user.username,
      connections: new Set<string>(),
    }

    state.connections.set(connection.id, connection)
    member.connections.add(connection.id)
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
      if (member.connections.size === 0) {
        state.members.delete(user.id)
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
        activity: "viewing" as const,
      }))
      .sort((left, right) => left.member.username < right.member.username ? -1 : 1)

    return boardSnapshotSchema.parse({
      type: "snapshot",
      board: connection.board.board,
      revision: connection.board.revision,
      presence,
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

  return collaboration
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
