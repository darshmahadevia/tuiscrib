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

test("auth client restores and signs out a Terminal Session through public HTTP", async () => {
  const credential = "a".repeat(43)
  const requests: Array<{ path: string; method?: string; authorization?: string; body?: string }> = []
  const client = createAuthClient("http://tuiscrib.test", async (input, init) => {
    const url = new URL(String(input))
    requests.push({
      path: url.pathname,
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? init.body : undefined,
    })

    if (url.pathname === "/auth/session") {
      return new Response(JSON.stringify({ user: { username: "ada_lovelace" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    return new Response(JSON.stringify({ status: "signed_out" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  await expect(client.restore(credential)).resolves.toEqual({
    user: { username: "ada_lovelace" },
  })
  await expect(client.signOut(credential)).resolves.toEqual({ status: "signed_out" })

  expect(requests).toEqual([
    {
      path: "/auth/session",
      method: "POST",
      authorization: `Bearer ${credential}`,
      body: undefined,
    },
    {
      path: "/auth/sign-out",
      method: "POST",
      authorization: `Bearer ${credential}`,
      body: undefined,
    },
  ])
})
