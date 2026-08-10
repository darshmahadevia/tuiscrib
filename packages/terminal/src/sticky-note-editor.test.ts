import { expect, test } from "bun:test"

import { MAX_STICKY_NOTE_CHARACTERS } from "@tuiscrib/contracts"

import {
  STICKY_NOTE_TEXT_DEBOUNCE_MS,
  createStickyNoteDebouncer,
  validateStickyNoteEditorText,
} from "./sticky-note-editor.ts"

test("publishes only the latest full-text snapshot after the idle debounce", () => {
  let now = 0
  let nextTimerId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const published: string[] = []
  const debouncer = createStickyNoteDebouncer({
    schedule: (callback, delay) => {
      const id = ++nextTimerId
      timers.set(id, { at: now + delay, callback })
      return id
    },
    cancel: (handle) => {
      timers.delete(handle as number)
    },
    publish: (text) => published.push(text),
  })

  debouncer.schedule("a")
  now = STICKY_NOTE_TEXT_DEBOUNCE_MS - 1
  debouncer.schedule("ab")
  expect(published).toEqual([])

  now = STICKY_NOTE_TEXT_DEBOUNCE_MS * 2
  for (const timer of [...timers.values()]) {
    if (timer.at <= now) {
      timer.callback()
    }
  }
  expect(published).toEqual(["ab"])
})

test("flushes one pending full-text snapshot immediately and cancels its timer", () => {
  let cancelled = 0
  const published: string[] = []
  const debouncer = createStickyNoteDebouncer({
    schedule: () => 1,
    cancel: () => {
      cancelled += 1
    },
    publish: (text) => published.push(text),
  })

  debouncer.schedule("pending")
  debouncer.flush()
  debouncer.flush()

  expect(published).toEqual(["pending"])
  expect(cancelled).toBe(1)
})

test("rejects over-limit editor text with a user-perceived Unicode error", () => {
  expect(validateStickyNoteEditorText("a".repeat(MAX_STICKY_NOTE_CHARACTERS))).toEqual({
    accepted: true,
  })

  const rejected = validateStickyNoteEditorText("a".repeat(MAX_STICKY_NOTE_CHARACTERS + 1))
  expect(rejected.accepted).toBe(false)
  if (!rejected.accepted) {
    expect(rejected.error).toContain("2,000 user-perceived Unicode characters")
  }
})
