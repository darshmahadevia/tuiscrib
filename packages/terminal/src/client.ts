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
  type StickyNoteEditClaimGranted,
  type StickyNoteUpdated,
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

export type BoardConnectionState =
  | "connecting"
  | "connected"
  | "waking"
  | "reconnecting"
  | "unavailable"
  | "unauthorized"
  | "closed"

export type BoardConnectionScheduler = {
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
  scheduleRepeating?(callback: () => void, intervalMs: number): unknown
}

export type BoardReconnectPolicy = (attempt: number) => number

export type BoardClientOptions = {
  scheduler?: BoardConnectionScheduler
  reconnectPolicy?: BoardReconnectPolicy
  heartbeatIntervalMs?: number
}

export type BoardConnectionHandlers = {
  onSnapshot(snapshot: BoardSnapshot): void
  onError(error: Error): void
  onClose(): void
  onConnectionState?(state: BoardConnectionState): void
  onStickyNoteCreationClaimGranted?(claim: StickyNoteCreationClaimGranted): void
  onStickyNoteCreated?(event: StickyNoteCreated): void
  onStickyNoteEditClaimGranted?(claim: StickyNoteEditClaimGranted): void
  onStickyNoteUpdated?(event: StickyNoteUpdated): void
  onCommandError?(error: BoardCommandError): void
}

export type BoardConnection = {
  send(command: BoardCommand): void
  close(): void
}

type BoardSocketGeneration = {
  id: number
  socket: BoardSocket
  awaitingSnapshot: boolean
  lastRevision: number | null
  lastSnapshotFingerprint: string | null
  pendingEvents: Map<number, StickyNoteCreated | StickyNoteUpdated>
  ending: boolean
  heartbeatHandle: unknown | null
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
  options: BoardClientOptions = {},
): BoardClient {
  const scheduler = options.scheduler ?? defaultBoardConnectionScheduler
  const reconnectPolicy = options.reconnectPolicy ?? createBoundedReconnectPolicy()
  const heartbeatIntervalMs = normalizeHeartbeatInterval(options.heartbeatIntervalMs)

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

      let closedByCaller = false
      let nextGeneration = 0
      let activeGeneration: BoardSocketGeneration | null = null
      let retryHandle: unknown | null = null
      let reconnectAttempt = 0

      const connection: BoardConnection = {
        send(command) {
          const parsed = boardCommandSchema.parse(command)
          const generation = activeGeneration
          if (closedByCaller) {
            throw new Error("Board collaboration is closed.")
          }
          if (!generation || generation.awaitingSnapshot) {
            throw new Error("Board collaboration is not connected; shared mutations are disabled.")
          }
          generation.socket.send(JSON.stringify(parsed))
        },
        close() {
          if (closedByCaller) {
            return
          }
          closedByCaller = true
          nextGeneration += 1
          if (retryHandle !== null) {
            scheduler.cancel(retryHandle)
            retryHandle = null
          }
          const generation = activeGeneration
          activeGeneration = null
          if (generation) {
            finishGeneration(generation)
            generation.socket.close()
          }
          handlers.onConnectionState?.("closed")
        },
      }

      handlers.onConnectionState?.("connecting")
      await connect(true)
      return connection

      async function connect(initial: boolean): Promise<void> {
        if (closedByCaller) {
          return
        }

        const generationId = ++nextGeneration
        if (!initial) {
          handlers.onConnectionState?.("reconnecting")
        }
        try {
          await requestBoard(
            "GET",
            credential,
            undefined,
            boardOpenReadyResponseSchema,
            httpUrl,
          )
        } catch (error) {
          if (closedByCaller || generationId !== nextGeneration) {
            return
          }
          if (initial) {
            if (isRetryableFailure(error)) {
              handleInitialRetryFailure(generationId, error)
              return
            }
            reportInitialFailure(error)
            throw error
          }
          handleRetryFailure(generationId, error)
          return
        }

        if (closedByCaller || generationId !== nextGeneration) {
          return
        }

        let socket: BoardSocket
        try {
          socket = webSocketFactory(toWebSocketUrl(httpUrl), {
            headers: { authorization: `Bearer ${credential}` },
          })
        } catch (error) {
          if (initial) {
            handleInitialRetryFailure(generationId, error)
            return
          }
          handleRetryFailure(generationId, error)
          return
        }

        const generation: BoardSocketGeneration = {
          id: generationId,
          socket,
          awaitingSnapshot: true,
          lastRevision: null,
          lastSnapshotFingerprint: null,
          pendingEvents: new Map(),
          ending: false,
          heartbeatHandle: null,
        }
        activeGeneration = generation
        socket.onmessage = (event) => handleMessage(generation, event)
        socket.onerror = () => {
          if (!isCurrent(generation) || generation.ending) {
            return
          }
          finishGenerationForRetry(
            generation,
            new Error("Board collaboration is unavailable."),
          )
        }
        socket.onclose = () => {
          if (!isCurrent(generation) || generation.ending) {
            return
          }
          finishGenerationForRetry(generation)
        }
      }

      function handleMessage(
        generation: BoardSocketGeneration,
        event: { data: unknown },
      ): void {
        if (!isCurrent(generation)) {
          return
        }

        let payload: unknown
        try {
          payload = JSON.parse(decodeSocketMessage(event.data))
        } catch {
          terminateForProtocolError(generation)
          return
        }

        const parsed = boardSocketMessageSchema.safeParse(payload)
        if (!parsed.success) {
          terminateForProtocolError(generation)
          return
        }

        if (parsed.data.type === "snapshot") {
          handleSnapshot(generation, parsed.data)
          return
        }

        if (parsed.data.type === "sticky_note_creation_claim_granted") {
          handlers.onStickyNoteCreationClaimGranted?.(parsed.data)
          return
        }

        if (parsed.data.type === "sticky_note_edit_claim_granted") {
          handlers.onStickyNoteEditClaimGranted?.(parsed.data)
          return
        }

        if (parsed.data.type === "error") {
          handlers.onCommandError?.(parsed.data)
          return
        }

        if (generation.awaitingSnapshot) {
          generation.pendingEvents.set(parsed.data.revision, parsed.data)
          return
        }

        applyDurableEvent(generation, parsed.data)
      }

      function handleSnapshot(
        generation: BoardSocketGeneration,
        snapshot: BoardSnapshot,
      ): void {
        if (!isCurrent(generation)) {
          return
        }
        const fingerprint = JSON.stringify(snapshot)
        if (generation.lastSnapshotFingerprint === fingerprint) {
          return
        }
        if (
          generation.lastRevision !== null &&
          snapshot.revision < generation.lastRevision
        ) {
          return
        }

        generation.lastSnapshotFingerprint = fingerprint
        generation.lastRevision = snapshot.revision
        generation.awaitingSnapshot = false
        reconnectAttempt = 0
        handlers.onSnapshot(snapshot)
        handlers.onConnectionState?.("connected")
        startHeartbeat(generation)
        drainPendingEvents(generation)
      }

      function startHeartbeat(generation: BoardSocketGeneration): void {
        if (heartbeatIntervalMs === 0 || generation.heartbeatHandle !== null) {
          return
        }
        const sendHeartbeat = () => {
          if (!isCurrent(generation) || generation.awaitingSnapshot || generation.ending) {
            return
          }
          try {
            generation.socket.send(JSON.stringify({ type: "heartbeat" }))
          } catch {
            finishGenerationForRetry(
              generation,
              new Error("Board collaboration is unavailable."),
            )
          }
        }
        generation.heartbeatHandle = scheduler.scheduleRepeating
          ? scheduler.scheduleRepeating(sendHeartbeat, heartbeatIntervalMs)
          : setInterval(sendHeartbeat, heartbeatIntervalMs)
      }

      function drainPendingEvents(generation: BoardSocketGeneration): void {
        if (!isCurrent(generation) || generation.lastRevision === null) {
          return
        }

        const pending = [...generation.pendingEvents.entries()]
          .filter(([revision]) => revision > generation.lastRevision!)
          .sort(([left], [right]) => left - right)
        generation.pendingEvents.clear()

        let expectedRevision = generation.lastRevision + 1
        for (const [revision] of pending) {
          if (revision !== expectedRevision) {
            requestAuthoritativeSnapshot(generation)
            return
          }
          expectedRevision += 1
        }

        for (const [, event] of pending) {
          if (!isCurrent(generation)) {
            return
          }
          applyDurableEvent(generation, event)
        }
      }

      function applyDurableEvent(
        generation: BoardSocketGeneration,
        event: StickyNoteCreated | StickyNoteUpdated,
      ): void {
        if (!isCurrent(generation) || generation.lastRevision === null) {
          return
        }
        if (event.revision <= generation.lastRevision) {
          return
        }
        if (event.revision !== generation.lastRevision + 1) {
          requestAuthoritativeSnapshot(generation)
          return
        }
        generation.lastRevision = event.revision
        if (event.type === "sticky_note_created") {
          handlers.onStickyNoteCreated?.(event)
        } else {
          handlers.onStickyNoteUpdated?.(event)
        }
      }

      function requestAuthoritativeSnapshot(generation: BoardSocketGeneration): void {
        if (!isCurrent(generation)) {
          return
        }
        finishGenerationForRetry(
          generation,
          new Error("Board collaboration revision gap detected; requesting an authoritative snapshot."),
        )
      }

      function terminateForProtocolError(generation: BoardSocketGeneration): void {
        if (!isCurrent(generation)) {
          return
        }
        generation.ending = true
        activeGeneration = null
        finishGeneration(generation)
        handlers.onError(new Error("Board collaboration sent an invalid snapshot."))
        generation.socket.close()
      }

      function finishGenerationForRetry(
        generation: BoardSocketGeneration,
        error?: Error,
      ): void {
        if (!isCurrent(generation) || generation.ending || closedByCaller) {
          return
        }
        generation.ending = true
        activeGeneration = null
        finishGeneration(generation)
        if (error) {
          handlers.onError(error)
        }
        handlers.onClose()
        handlers.onConnectionState?.("reconnecting")
        generation.socket.close()
        scheduleRetry()
      }

      function scheduleRetry(): void {
        if (closedByCaller || retryHandle !== null) {
          return
        }
        reconnectAttempt += 1
        const requestedDelay = reconnectPolicy(reconnectAttempt)
        const delayMs = Number.isFinite(requestedDelay)
          ? Math.max(0, Math.floor(requestedDelay))
          : 0
        retryHandle = scheduler.schedule(() => {
          retryHandle = null
          void connect(false)
        }, delayMs)
      }

      function handleRetryFailure(generationId: number, error: unknown): void {
        if (closedByCaller || generationId !== nextGeneration) {
          return
        }
        const serviceError = error instanceof ServiceRequestError ? error : null
        if (serviceError?.status === 401) {
          handlers.onConnectionState?.("unauthorized")
          handlers.onError(serviceError)
          return
        }
        if (serviceError?.status === 404) {
          handlers.onConnectionState?.("closed")
          handlers.onError(serviceError)
          return
        }
        if (!isRetryableFailure(error)) {
          handlers.onConnectionState?.("unavailable")
          handlers.onError(error instanceof Error ? error : new Error("Board collaboration is unavailable."))
          return
        }
        handlers.onConnectionState?.(connectionStateForFailure(error))
        handlers.onError(error instanceof Error ? error : new Error("Board collaboration is unavailable."))
        scheduleRetry()
      }

      function handleInitialRetryFailure(generationId: number, error: unknown): void {
        if (closedByCaller || generationId !== nextGeneration) {
          return
        }
        handlers.onConnectionState?.(connectionStateForFailure(error))
        handlers.onError(error instanceof Error ? error : new Error("Board collaboration is unavailable."))
        scheduleRetry()
      }

      function reportInitialFailure(error: unknown): void {
        if (closedByCaller) {
          return
        }
        const serviceError = error instanceof ServiceRequestError ? error : null
        handlers.onConnectionState?.(
          serviceError?.status === 401
            ? "unauthorized"
            : serviceError?.status === 404
              ? "closed"
              : "unavailable",
        )
        handlers.onError(error instanceof Error ? error : new Error("Board collaboration is unavailable."))
      }

      function isCurrent(generation: BoardSocketGeneration): boolean {
        return !closedByCaller && activeGeneration === generation && generation.id === nextGeneration
      }

      function finishGeneration(generation: BoardSocketGeneration): void {
        if (generation.heartbeatHandle !== null) {
          if (scheduler.scheduleRepeating) {
            scheduler.cancel(generation.heartbeatHandle)
          } else {
            clearInterval(generation.heartbeatHandle as ReturnType<typeof setInterval>)
          }
          generation.heartbeatHandle = null
        }
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

    try {
      return schema.parse(payload)
    } catch {
      throw new BoardResponseError("The Tuiscrib Service returned an invalid Board response.")
    }
  }
}

class BoardResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BoardResponseError"
  }
}

const defaultBoardConnectionScheduler: BoardConnectionScheduler = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  scheduleRepeating(callback, intervalMs) {
    return setInterval(callback, intervalMs)
  },
}

export function createBoundedReconnectPolicy(options: {
  initialDelayMs?: number
  maximumDelayMs?: number
  multiplier?: number
} = {}): BoardReconnectPolicy {
  const initialDelayMs = normalizeReconnectNumber(options.initialDelayMs, 250)
  const maximumDelayMs = Math.max(
    initialDelayMs,
    normalizeReconnectNumber(options.maximumDelayMs, 30_000),
  )
  const multiplier = Math.max(1, normalizeReconnectNumber(options.multiplier, 2))

  return (attempt) => {
    const normalizedAttempt = Math.max(1, Math.floor(attempt))
    return Math.min(
      maximumDelayMs,
      initialDelayMs * Math.pow(multiplier, normalizedAttempt - 1),
    )
  }
}

function normalizeReconnectNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

function normalizeHeartbeatInterval(value: number | undefined): number {
  if (value === 0) {
    return 0
  }
  return value !== undefined && Number.isFinite(value) && value >= 1_000
    ? Math.floor(value)
    : 30_000
}

function isRetryableFailure(error: unknown): boolean {
  if (error instanceof BoardResponseError) {
    return false
  }
  if (!(error instanceof ServiceRequestError)) {
    return true
  }
  return error.status === 408 || error.status >= 500
}

function connectionStateForFailure(error: unknown): "waking" | "unavailable" {
  return error instanceof ServiceRequestError &&
    (error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504)
    ? "waking"
    : "unavailable"
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
