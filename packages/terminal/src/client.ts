import {
  authResponseSchema,
  healthResponseSchema,
  serviceErrorSchema,
  type AuthResponse,
  type RegisterRequest,
  type ServiceError,
  type SignInRequest,
  type HealthResponse,
} from "@tuiscrib/contracts"

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type AuthClient = {
  register(input: RegisterRequest): Promise<AuthResponse>
  signIn(input: SignInRequest): Promise<AuthResponse>
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
}
