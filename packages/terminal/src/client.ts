import {
  healthResponseSchema,
  serviceErrorSchema,
  type HealthResponse,
} from "@tuiscrib/contracts"

export type HealthClient = {
  checkHealth(): Promise<HealthResponse>
}

export function createHealthClient(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
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
