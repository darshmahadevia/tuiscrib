import {
  boardCommandSchema,
  boardOpenReadyResponseSchema,
  boardListResponseSchema,
  boardSocketMessageSchema,
  createBoardResponseSchema,
  joinBoardResponseSchema,
  leaveBoardResponseSchema,
  renameBoardResponseSchema,
  rotateJoinCodeResponseSchema,
  authResponseSchema,
  healthResponseSchema,
  signOutResponseSchema,
  serviceErrorSchema,
  terminalSessionResponseSchema,
  type AuthResponse,
  type BoardSnapshot,
  type BoardCommand,
  type BoardCommandError,
  type StickyNoteCreated,
  type StickyNoteCreationClaimGranted,
  type BoardListResponse,
  type CreateBoardRequest,
  type CreateBoardResponse,
  type JoinBoardRequest,
  type JoinBoardResponse,
  type LeaveBoardResponse,
  type RenameBoardRequest,
  type RenameBoardResponse,
  type RotateJoinCodeResponse,
  type RegisterRequest,
  type SignOutResponse,
  type ServiceError,
  type SignInRequest,
  type TerminalSessionResponse,
  type HealthResponse,
} from "@tuiscrib/contracts"

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type AuthClient = {
  register(input: RegisterRequest): Promise<AuthResponse>
  signIn(input: SignInRequest): Promise<AuthResponse>
  restore(credential: string): Promise<TerminalSessionResponse>
  signOut(credential: string): Promise<SignOutResponse>
}

export type BoardClient = {
  createBoard(credential: string, input: CreateBoardRequest): Promise<CreateBoardResponse>
  joinBoard(credential: string, input: JoinBoardRequest): Promise<JoinBoardResponse>
  leaveBoard(credential: string, boardId: string): Promise<LeaveBoardResponse>
  renameBoard(
    credential: string,
    boardId: string,
    input: RenameBoardRequest,
  ): Promise<RenameBoardResponse>
  rotateJoinCode(credential: string, boardId: string): Promise<RotateJoinCodeResponse>
  listBoards(credential: string, filter?: string): Promise<BoardListResponse>
  openBoard?(
    credential: string,
    boardId: string,
    handlers: BoardConnectionHandlers,
  ): Promise<BoardConnection>
}

export type BoardSocket = {
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(): void
}

export type BoardWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => BoardSocket

export type BoardConnectionHandlers = {
  onSnapshot(snapshot: BoardSnapshot): void
  onError(error: Error): void
  onClose(): void
  onStickyNoteCreationClaimGranted?(claim: StickyNoteCreationClaimGranted): void
  onStickyNoteCreated?(event: StickyNoteCreated): void
  onCommandError?(error: BoardCommandError): void
}

export type BoardConnection = {
  send(command: BoardCommand): void
  close(): void
}

export class ServiceRequestError extends Error {
  readonly status: number
  readonly details: ServiceError

  constructor(status: number, details: ServiceError) {
    super(details.error)
    this.name = "ServiceRequestError"
    this.status = status
    this.details = details
  }
}

export type HealthClient = {
  checkHealth(): Promise<HealthResponse>
}

export function createHealthClient(
  baseUrl: string,
  fetcher: Fetcher = fetch,
): HealthClient {
  return {
    async checkHealth() {
      const url = new URL("/health", baseUrl)
      url.searchParams.set("probe", "readiness")
      const response = await fetcher(url)
      const payload: unknown = await response.json()

      if (!response.ok) {
        const error = serviceErrorSchema.safeParse(payload)
        throw new Error(error.success ? error.data.error : "service unavailable")
      }

      return healthResponseSchema.parse(payload)
    },
  }
}

export function createAuthClient(
  baseUrl: string,
  fetcher: Fetcher = fetch,
): AuthClient {
  return {
    register(input) {
      return requestAuth("/auth/register", input)
    },
    signIn(input) {
      return requestAuth("/auth/sign-in", input)
    },
    restore(credential) {
      return requestSession("/auth/session", credential, terminalSessionResponseSchema)
    },
    signOut(credential) {
      return requestSession("/auth/sign-out", credential, signOutResponseSchema)
    },
  }

  async function requestAuth(
    path: string,
    input: RegisterRequest | SignInRequest,
  ): Promise<AuthResponse> {
    const response = await fetcher(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    const payload: unknown = await response.json().catch(() => undefined)

    if (!response.ok) {
      const details = serviceErrorSchema.safeParse(payload)
      throw new ServiceRequestError(
        response.status,
        details.success ? details.data : { error: "service unavailable" },
      )
    }

    return authResponseSchema.parse(payload)
  }

  async function requestSession<T>(
    path: string,
    credential: string,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    const response = await fetcher(new URL(path, baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    })
    const payload: unknown = await response.json().catch(() => undefined)

    if (!response.ok) {
      const details = serviceErrorSchema.safeParse(payload)
      throw new ServiceRequestError(
        response.status,
        details.success ? details.data : { error: "service unavailable" },
      )
    }

    return schema.parse(payload)
  }
}

export function createBoardClient(
  baseUrl: string,
  fetcher: Fetcher = fetch,
  webSocketFactory: BoardWebSocketFactory = defaultBoardWebSocketFactory,
): BoardClient {
  return {
    createBoard(credential, input) {
      return requestBoard("POST", credential, input, createBoardResponseSchema)
    },
    joinBoard(credential, input) {
      return requestBoard(
        "POST",
        credential,
        input,
        joinBoardResponseSchema,
        new URL("/boards/join", baseUrl),
      )
    },
    leaveBoard(credential, boardId) {
      return requestBoard(
        "POST",
        credential,
        undefined,
        leaveBoardResponseSchema,
        new URL(`/boards/${encodeURIComponent(boardId)}/leave`, baseUrl),
      )
    },
    renameBoard(credential, boardId, input) {
      return requestBoard(
        "POST",
        credential,
        input,
        renameBoardResponseSchema,
        new URL(`/boards/${encodeURIComponent(boardId)}/rename`, baseUrl),
      )
    },
    rotateJoinCode(credential, boardId) {
      return requestBoard(
        "POST",
        credential,
        undefined,
        rotateJoinCodeResponseSchema,
        new URL(`/boards/${encodeURIComponent(boardId)}/rotate-join-code`, baseUrl),
      )
    },
    listBoards(credential, filter = "") {
      const url = new URL("/boards", baseUrl)
      if (filter.length > 0) {
        url.searchParams.set("filter", filter)
      }
      return requestBoard("GET", credential, undefined, boardListResponseSchema, url)
    },
    async openBoard(credential, boardId, handlers) {
      const httpUrl = new URL(
        `/boards/${encodeURIComponent(boardId)}/collaboration`,
        baseUrl,
      )
      await requestBoard(
        "GET",
        credential,
        undefined,
        boardOpenReadyResponseSchema,
        httpUrl,
      )

      const socket = webSocketFactory(toWebSocketUrl(httpUrl), {
        headers: { authorization: `Bearer ${credential}` },
      })
      let closedByCaller = false
      let lastRevision: number | null = null
      socket.onmessage = (event) => {
        let payload: unknown
        try {
          payload = JSON.parse(decodeSocketMessage(event.data))
        } catch {
          closedByCaller = true
          handlers.onError(new Error("Board collaboration sent an invalid snapshot."))
          socket.close()
          return
        }

        const parsed = boardSocketMessageSchema.safeParse(payload)
        if (!parsed.success) {
          closedByCaller = true
          handlers.onError(new Error("Board collaboration sent an invalid snapshot."))
          socket.close()
          return
        }

        if (parsed.data.type === "snapshot") {
          if (lastRevision !== null && parsed.data.revision < lastRevision) {
            return
          }
          lastRevision = parsed.data.revision
          handlers.onSnapshot(parsed.data)
          return
        }

        if (parsed.data.type === "sticky_note_creation_claim_granted") {
          handlers.onStickyNoteCreationClaimGranted?.(parsed.data)
          return
        }

        if (parsed.data.type === "sticky_note_created") {
          if (lastRevision !== null && parsed.data.revision <= lastRevision) {
            return
          }
          if (lastRevision !== null && parsed.data.revision !== lastRevision + 1) {
            closedByCaller = true
            handlers.onError(new Error("Board collaboration revision gap detected."))
            socket.close()
            return
          }
          lastRevision = parsed.data.revision
          handlers.onStickyNoteCreated?.(parsed.data)
          return
        }

        if (parsed.data.type === "error") {
          handlers.onCommandError?.(parsed.data)
        }
      }
      socket.onerror = () => {
        if (!closedByCaller) {
          handlers.onError(new Error("Board collaboration is unavailable."))
        }
      }
      socket.onclose = () => {
        if (!closedByCaller) {
          handlers.onClose()
        }
      }

      return {
        send(command) {
          const parsed = boardCommandSchema.parse(command)
          if (closedByCaller) {
            throw new Error("Board collaboration is closed.")
          }
          socket.send(JSON.stringify(parsed))
        },
        close() {
          closedByCaller = true
          socket.close()
        },
      }
    },
  }

  async function requestBoard<T>(
    method: "GET" | "POST",
    credential: string,
    input: CreateBoardRequest | JoinBoardRequest | RenameBoardRequest | undefined,
    schema: { parse(value: unknown): T },
    url = new URL("/boards", baseUrl),
  ): Promise<T> {
    const response = await fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        ...(input ? { "content-type": "application/json" } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    })
    const payload: unknown = await response.json().catch(() => undefined)

    if (!response.ok) {
      const details = serviceErrorSchema.safeParse(payload)
      throw new ServiceRequestError(
        response.status,
        details.success ? details.data : { error: "service unavailable" },
      )
    }

    return schema.parse(payload)
  }
}

const defaultBoardWebSocketFactory: BoardWebSocketFactory = (url, options) => {
  const WebSocketConstructor = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => BoardSocket
  return new WebSocketConstructor(url, options)
}

function toWebSocketUrl(url: URL): string {
  const websocketUrl = new URL(url.toString())
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:"
  return websocketUrl.toString()
}

function decodeSocketMessage(data: unknown): string {
  if (typeof data === "string") {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data)
  }
  return String(data)
}
