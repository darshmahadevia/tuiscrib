import { z } from "zod"

const USERNAME_PATTERN = /^[a-z0-9_-]{3,24}$/
const MIN_PASSWORD_CHARACTERS = 8
const MAX_PASSWORD_CHARACTERS = 128
const TERMINAL_SESSION_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/

let graphemeSegmenter: Intl.Segmenter | undefined

function getGraphemeSegmenter(): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter === "undefined") {
    return undefined
  }

  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })
  return graphemeSegmenter
}

export function countUserPerceivedCharacters(value: string): number {
  return splitUserPerceivedCharacters(value).length
}

export function splitUserPerceivedCharacters(value: string): string[] {
  const segmenter = getGraphemeSegmenter()
  return segmenter
    ? Array.from(segmenter.segment(value), (segment) => segment.segment)
    : Array.from(value)
}

export const usernameSchema = z.string().regex(
  USERNAME_PATTERN,
  "Use 3-24 lowercase ASCII letters, digits, hyphens, or underscores.",
)

export const registrationPasswordSchema = z.string().superRefine((value, context) => {
  const characterCount = countUserPerceivedCharacters(value)
  if (characterCount < MIN_PASSWORD_CHARACTERS || characterCount > MAX_PASSWORD_CHARACTERS) {
    context.addIssue({
      code: "custom",
      message: "Use 8-128 user-perceived Unicode characters; spaces are allowed.",
    })
  }
})

export const registerRequestSchema = z
  .object({
    username: usernameSchema,
    password: registrationPasswordSchema,
    confirmation: z.string(),
  })
  .superRefine((value, context) => {
    if (value.password !== value.confirmation) {
      context.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: "Passwords do not match.",
      })
    }
  })

export const signInRequestSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, "Password is required."),
})

export const terminalSessionCredentialSchema = z.string().regex(
  TERMINAL_SESSION_CREDENTIAL_PATTERN,
  "Terminal Session credential has an invalid shape.",
)

export const authenticatedUserSchema = z.object({
  username: usernameSchema,
})

export const authResponseSchema = z.object({
  user: authenticatedUserSchema,
  sessionCredential: z.string().min(1),
})

export const terminalSessionResponseSchema = z.object({
  user: authenticatedUserSchema,
})

export const signOutResponseSchema = z.object({
  status: z.literal("signed_out"),
})

export const authErrorCodeSchema = z.enum([
  "invalid_input",
  "username_unavailable",
  "invalid_credentials",
  "rate_limited",
])

export type RegisterRequest = z.infer<typeof registerRequestSchema>
export type SignInRequest = z.infer<typeof signInRequestSchema>
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>
export type AuthResponse = z.infer<typeof authResponseSchema>
export type TerminalSessionResponse = z.infer<typeof terminalSessionResponseSchema>
export type SignOutResponse = z.infer<typeof signOutResponseSchema>
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>
