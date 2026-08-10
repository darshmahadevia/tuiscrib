import { expect, test } from "bun:test"

import {
  countUserPerceivedCharacters,
  splitUserPerceivedCharacters,
} from "./auth.ts"
import { stickyNoteTextSchema } from "./sticky-notes.ts"

test("counts Unicode grapheme clusters as user-perceived characters", () => {
  const value = "e\u0301👩🏽‍💻🇺🇳"

  expect(countUserPerceivedCharacters(value)).toBe(3)
  expect(splitUserPerceivedCharacters(value)).toEqual(["e\u0301", "👩🏽‍💻", "🇺🇳"])
})

test("accepts 2,000 user-perceived characters even when graphemes use multiple code points", () => {
  const exactlyAtLimit = "e\u0301".repeat(2_000)
  const overLimit = `${exactlyAtLimit}e\u0301`

  expect(stickyNoteTextSchema.safeParse(exactlyAtLimit).success).toBe(true)
  expect(stickyNoteTextSchema.safeParse(overLimit).success).toBe(false)
})

test("fails closed when the shared grapheme runtime is unavailable", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter")
  try {
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      value: undefined,
    })

    expect(() => countUserPerceivedCharacters("text")).toThrow("unavailable")
    expect(stickyNoteTextSchema.safeParse("text").success).toBe(false)
  } finally {
    if (descriptor) {
      Object.defineProperty(Intl, "Segmenter", descriptor)
    }
  }
})
