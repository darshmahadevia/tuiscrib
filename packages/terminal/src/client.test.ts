import { expect, test } from "bun:test"

import { createAuthClient } from "./client.ts"

test("auth client sends registration through the public HTTP contract", async () => {
  let requestBody = ""
  const client = createAuthClient("http://tuiscrib.test", async (_input, init) => {
    requestBody = String(init?.body)
    return new Response(
      JSON.stringify({
        user: { username: "ada_lovelace" },
        sessionCredential: "opaque-session",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    )
  })

  const response = await client.register({
    username: "ada_lovelace",
    password: "correct horse",
    confirmation: "correct horse",
  })

  expect(response).toEqual({
    user: { username: "ada_lovelace" },
    sessionCredential: "opaque-session",
  })
  expect(JSON.parse(requestBody)).toEqual({
    username: "ada_lovelace",
    password: "correct horse",
    confirmation: "correct horse",
  })
})
