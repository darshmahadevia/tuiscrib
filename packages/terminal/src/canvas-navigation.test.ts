import { expect, test } from "bun:test"

import {
  applyCanvasNavigation,
  CANVAS_STICKY_NOTE_CARD_HEIGHT,
  CANVAS_STICKY_NOTE_CARD_WIDTH,
  canvasCoordinateToScreen,
  canvasPointIsInsideRect,
  canvasRectIntersectsViewport,
  compareCanvasStackingOrder,
  createCanvasNavigationState,
  getCanvasStickyNoteCardHeight,
  getCanvasViewportSize,
  nearestCanvasNote,
  selectCanvasNoteInDirection,
  sortCanvasStackingOrder,
  type CanvasViewportSize,
} from "./canvas-navigation.ts"

const viewportSize: CanvasViewportSize = { width: 4, height: 3 }

test("opens at the stable origin and includes the visible edges", () => {
  let state = createCanvasNavigationState()

  expect(state).toEqual({
    cursor: { x: 0, y: 0 },
    viewport: { x: 0, y: 0 },
  })

  state = applyCanvasNavigation(state, "right", viewportSize)
  state = applyCanvasNavigation(state, "right", viewportSize)
  state = applyCanvasNavigation(state, "right", viewportSize)

  expect(state).toEqual({
    cursor: { x: 3, y: 0 },
    viewport: { x: 0, y: 0 },
  })

  state = applyCanvasNavigation(state, "right", viewportSize)
  expect(state).toEqual({
    cursor: { x: 4, y: 0 },
    viewport: { x: 1, y: 0 },
  })
})

test("moves the cursor on the bounded integer coordinate plane", () => {
  let state = createCanvasNavigationState()

  state = applyCanvasNavigation(state, "left", viewportSize)
  state = applyCanvasNavigation(state, "up", viewportSize)

  expect(state.cursor).toEqual({ x: -1, y: -1 })
  expect(state.viewport).toEqual({ x: -1, y: -1 })
})

test("Ctrl navigation pans the viewport without moving the cursor", () => {
  let state = createCanvasNavigationState()
  state = applyCanvasNavigation(state, "right", viewportSize)
  state = applyCanvasNavigation(state, "right", viewportSize)

  state = applyCanvasNavigation(state, "down", viewportSize, { pan: true })
  state = applyCanvasNavigation(state, "left", viewportSize, { pan: true })

  expect(state).toEqual({
    cursor: { x: 2, y: 0 },
    viewport: { x: -1, y: 1 },
  })
})

test("rejects a viewport with no visible cells", () => {
  expect(() => applyCanvasNavigation(createCanvasNavigationState(), "right", {
    width: 0,
    height: 3,
  })).toThrow("Canvas viewport dimensions must be positive integers")
})

test("maps world coordinates to viewport cells and includes only visible edges", () => {
  expect(canvasCoordinateToScreen({ x: 12, y: -4 }, { x: 10, y: -6 })).toEqual({ x: 2, y: 2 })

  expect(canvasRectIntersectsViewport(
    { left: 0, top: 0, width: 1, height: 1 },
    { x: 0, y: 0 },
    viewportSize,
  )).toBe(true)
  expect(canvasRectIntersectsViewport(
    { left: 3, top: 2, width: 1, height: 1 },
    { x: 0, y: 0 },
    viewportSize,
  )).toBe(true)
  expect(canvasRectIntersectsViewport(
    { left: 4, top: 0, width: 1, height: 1 },
    { x: 0, y: 0 },
    viewportSize,
  )).toBe(false)
  expect(canvasRectIntersectsViewport(
    { left: -1, top: 0, width: 1, height: 1 },
    { x: 0, y: 0 },
    viewportSize,
  )).toBe(false)
})

test("uses the rendered Sticky Note card dimensions for viewport culling", () => {
  expect(CANVAS_STICKY_NOTE_CARD_WIDTH / CANVAS_STICKY_NOTE_CARD_HEIGHT).toBe(2.25)
  expect(getCanvasStickyNoteCardHeight(1)).toBe(3)
  expect(getCanvasStickyNoteCardHeight(3)).toBe(5)
  expect(() => getCanvasStickyNoteCardHeight(0)).toThrow(
    "Sticky Note line count must be a positive integer",
  )
})

test("uses a deterministic front-to-back Stacking Order for hit testing and cycling", () => {
  const notes = [
    { id: "middle", stackingOrder: 1 },
    { id: "front", stackingOrder: 2 },
    { id: "back", stackingOrder: 0 },
  ]

  expect(sortCanvasStackingOrder(notes, "front-to-back").map((note) => note.id)).toEqual([
    "front",
    "middle",
    "back",
  ])
  expect(sortCanvasStackingOrder(notes, "back-to-front").map((note) => note.id)).toEqual([
    "back",
    "middle",
    "front",
  ])
  expect(compareCanvasStackingOrder(
    { id: "a", stackingOrder: 4 },
    { id: "b", stackingOrder: 4 },
  )).toBeLessThan(0)
  expect(canvasPointIsInsideRect(
    { x: 2, y: 3 },
    { left: 0, top: 0, width: 4, height: 5 },
  )).toBe(true)
  expect(canvasPointIsInsideRect(
    { x: 4, y: 3 },
    { left: 0, top: 0, width: 4, height: 5 },
  )).toBe(false)
})

test("derives deterministic viewport sizes for supported and below-minimum terminals", () => {
  expect(getCanvasViewportSize(80, 24)).toEqual({ width: 80, height: 23 })
  expect(getCanvasViewportSize(100, 30)).toEqual({ width: 100, height: 29 })
  expect(getCanvasViewportSize(79, 24)).toEqual({ width: 79, height: 23 })
})

test("keeps the viewport inside the shared coordinate plane at its bounds", () => {
  let state = createCanvasNavigationState()
  for (let index = 0; index < 1_000_000; index += 1) {
    state = applyCanvasNavigation(state, "right", viewportSize)
  }
  expect(state.cursor).toEqual({ x: 1_000_000, y: 0 })
  expect(state.viewport.x).toBe(999_997)

  state = applyCanvasNavigation(state, "right", viewportSize, { pan: true })
  expect(state.viewport.x).toBe(999_997)
})

test("selects Sticky Notes spatially with ordinary arrow directions", () => {
  const notes = [
    { id: "origin", position: { x: 0, y: 0 } },
    { id: "right", position: { x: 40, y: -2 } },
    { id: "below", position: { x: 0, y: 8 } },
  ]

  expect(nearestCanvasNote(notes, { x: 16, y: 1 })?.id).toBe("origin")
  expect(selectCanvasNoteInDirection(notes, "origin", "right")?.id).toBe("right")
  expect(selectCanvasNoteInDirection(notes, "origin", "down")?.id).toBe("below")
  expect(selectCanvasNoteInDirection(notes, "origin", "left")).toBeUndefined()
})
