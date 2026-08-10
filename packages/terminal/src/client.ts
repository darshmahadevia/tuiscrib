import {
  boardListResponseSchema,
  createBoardResponseSchema,
  joinBoardResponseSchema,
  leaveBoardResponseSchema,
  authResponseSchema,
  healthResponseSchema,
  signOutResponseSchema,
  serviceErrorSchema,
  terminalSessionResponseSchema,
  type AuthResponse,
  type BoardListResponse,
  type CreateBoardRequest,
  type CreateBoardResponse,
  type JoinBoardRequest,
  type JoinBoardResponse,
  type LeaveBoardResponse,
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
  listBoards(credential: string, filter?: string): Promise<BoardListResponse>
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
    listBoards(credential, filter = "") {
      const url = new URL("/boards", baseUrl)
      if (filter.length > 0) {
        url.searchParams.set("filter", filter)
      }
      return requestBoard("GET", credential, undefined, boardListResponseSchema, url)
    },
  }

  async function requestBoard<T>(
    method: "GET" | "POST",
    credential: string,
    input: CreateBoardRequest | JoinBoardRequest | undefined,
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
