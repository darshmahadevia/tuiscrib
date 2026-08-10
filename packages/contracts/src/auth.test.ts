import { expect, test } from "bun:test"

import { registerRequestSchema, signInRequestSchema } from "./auth.ts"

test("registration accepts lowercase usernames and Unicode passwords by user-perceived length", () => {
  const result = registerRequestSchema.safeParse({
    username: "ada_lovelace",
    password: "😀😀😀😀😀😀😀😀",
    confirmation: "😀😀😀😀😀😀😀😀",
  })

  expect(result.success).toBe(true)
})

test("registration rejects fewer than eight user-perceived characters", () => {
  const result = registerRequestSchema.safeParse({
    username: "ada_lovelace",
    password: "éééééée",
    confirmation: "éééééée",
  })

  expect(result.success).toBe(false)
})

test("sign-in accepts a nonempty password without exposing password policy details", () => {
  const result = signInRequestSchema.safeParse({
    username: "ada_lovelace",
    password: "short",
  })

  expect(result.success).toBe(true)
})
