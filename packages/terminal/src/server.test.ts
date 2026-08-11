import { expect, test } from "bun:test"

import {
  DEFAULT_TUISCRIB_SERVER_URL,
  resolveServerUrl,
  validateServerUrl,
} from "./server.ts"

test("uses the hosted service by default and honors flag over environment precedence", () => {
  expect(resolveServerUrl([], {})).toBe(DEFAULT_TUISCRIB_SERVER_URL)
  expect(resolveServerUrl([], { TUISCRIB_URL: "http://env.example:3000/" })).toBe(
    "http://env.example:3000",
  )
  expect(resolveServerUrl(
    ["--server", "https://flag.example/"],
    { TUISCRIB_URL: "http://env.example:3000" },
  )).toBe("https://flag.example")
  expect(resolveServerUrl(
    ["--server=https://inline.example"],
    { TUISCRIB_URL: "http://env.example:3000" },
  )).toBe("https://inline.example")
})

test("validates server origins without exposing credentials or path ambiguity", () => {
  expect(validateServerUrl("https://tuiscrib.onrender.com/")).toBe(
    "https://tuiscrib.onrender.com",
  )
  expect(validateServerUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")

  for (const value of [
    "",
    "not a URL",
    "ftp://tuiscrib.example",
    "https://user:password@tuiscrib.example",
    "https://tuiscrib.example/api",
    "https://tuiscrib.example/?probe=readiness",
    "https://tuiscrib.example/#board",
  ]) {
    expect(() => validateServerUrl(value, "--server")).toThrow(
      "--server must be an http(s) server origin",
    )
  }
})

test("rejects missing, unknown, and duplicate server arguments", () => {
  expect(() => resolveServerUrl(["--server"], {})).toThrow("--server requires a URL")
  expect(() => resolveServerUrl(["--unknown"], {})).toThrow("Unknown terminal argument")
  expect(() => resolveServerUrl(["--server", "https://one.example", "--server", "https://two.example"], {}))
    .toThrow("--server may only be provided once")
})
