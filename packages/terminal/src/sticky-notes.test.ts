import { expect, test } from "bun:test"

import { STICKY_NOTE_WIDTH, wrapStickyNoteText } from "./sticky-notes.ts"

test("wraps multiline Unicode text at 32 terminal columns without losing content", () => {
  const text = "12345678901234567890123456789012\n世界🙂abc"
  const wrapped = wrapStickyNoteText(text)

  expect(wrapped).toEqual([
    "12345678901234567890123456789012",
    "世界🙂abc",
  ])
  expect(wrapped.join("\n")).toBe(text)
  expect(wrapped.every((line) => Bun.stringWidth(line) <= STICKY_NOTE_WIDTH)).toBe(true)
})

test("auto-growth is represented by one rendered line per wrapped line", () => {
  const wrapped = wrapStickyNoteText("a".repeat(STICKY_NOTE_WIDTH * 2 + 1))

  expect(wrapped).toHaveLength(3)
  expect(wrapped[0]).toHaveLength(STICKY_NOTE_WIDTH)
  expect(wrapped[1]).toHaveLength(STICKY_NOTE_WIDTH)
  expect(wrapped[2]).toHaveLength(1)
})
