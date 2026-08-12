import { compareStickyNoteStackingOrder } from "@tuiscrib/contracts"

export const CANVAS_MIN_COORDINATE = -1_000_000
export const CANVAS_MAX_COORDINATE = 1_000_000
export const CANVAS_PANEL_WIDTH = 72
// Ghostty cells are about 2.25 times taller than they are wide, so this cell
// footprint renders as a visual square rather than a tall rectangle.
export const CANVAS_STICKY_NOTE_CARD_WIDTH = 26
export const CANVAS_STICKY_NOTE_CARD_HEIGHT = 11
export const CANVAS_STICKY_NOTE_CARD_VERTICAL_OVERHEAD = 2

export type CanvasCoordinate = {
  x: number
  y: number
}

export type CanvasViewportSize = {
  width: number
  height: number
}

export type CanvasNavigationState = {
  cursor: CanvasCoordinate
  viewport: CanvasCoordinate
}

export type CanvasDirection = "up" | "down" | "left" | "right"

export type CanvasRect = {
  left: number
  top: number
  width: number
  height: number
}

export type CanvasStackingOrderItem = {
  id: string
  stackingOrder: number
}

/**
 * Compare the persisted order from back to front. Valid Board state has one
 * order value per Sticky Note; the public id tie-break keeps malformed or
 * legacy snapshots deterministic without inventing client-local order.
 */
export function compareCanvasStackingOrder(
  left: CanvasStackingOrderItem,
  right: CanvasStackingOrderItem,
): number {
  return compareStickyNoteStackingOrder(left, right)
}

export function sortCanvasStackingOrder<T extends CanvasStackingOrderItem>(
  items: readonly T[],
  direction: "back-to-front" | "front-to-back" = "back-to-front",
): T[] {
  return [...items].sort((left, right) => {
    if (left.stackingOrder !== right.stackingOrder) {
      return direction === "back-to-front"
        ? left.stackingOrder - right.stackingOrder
        : right.stackingOrder - left.stackingOrder
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

export function canvasPointIsInsideRect(
  point: CanvasCoordinate,
  rect: CanvasRect,
): boolean {
  return (
    point.x >= rect.left &&
    point.x < rect.left + rect.width &&
    point.y >= rect.top &&
    point.y < rect.top + rect.height
  )
}

export function createCanvasNavigationState(): CanvasNavigationState {
  return {
    cursor: { x: 0, y: 0 },
    viewport: { x: 0, y: 0 },
  }
}

export function getCanvasPanelWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth)
}

export function getCanvasViewportSize(
  terminalWidth: number,
  terminalHeight: number,
): CanvasViewportSize {
  const panelWidth = getCanvasPanelWidth(terminalWidth)
  return {
    width: Math.max(1, panelWidth),
    height: Math.max(1, terminalHeight - 1),
  }
}

export function getCanvasStickyNoteCardRect(position: CanvasCoordinate): CanvasRect {
  return {
    left: position.x,
    top: position.y,
    width: CANVAS_STICKY_NOTE_CARD_WIDTH,
    height: CANVAS_STICKY_NOTE_CARD_HEIGHT,
  }
}

export function nearestCanvasNote<T extends { id: string; position: CanvasCoordinate }>(
  notes: readonly T[],
  point: CanvasCoordinate,
): T | undefined {
  return [...notes].sort((left, right) => {
    const leftDistance = distanceSquared(noteCenter(left.position), point)
    const rightDistance = distanceSquared(noteCenter(right.position), point)
    if (leftDistance !== rightDistance) return leftDistance - rightDistance
    const leftStackingOrder = "stackingOrder" in left && typeof left.stackingOrder === "number"
      ? left.stackingOrder
      : undefined
    const rightStackingOrder = "stackingOrder" in right && typeof right.stackingOrder === "number"
      ? right.stackingOrder
      : undefined
    if (leftStackingOrder !== undefined && rightStackingOrder !== undefined && leftStackingOrder !== rightStackingOrder) {
      return rightStackingOrder - leftStackingOrder
    }
    return compareCanvasNoteIds(left.id, right.id)
  })[0]
}

export function selectCanvasNoteInDirection<T extends { id: string; position: CanvasCoordinate }>(
  notes: readonly T[],
  selectedId: string | null,
  direction: CanvasDirection,
): T | undefined {
  if (notes.length === 0) return undefined
  const current = selectedId ? notes.find((note) => note.id === selectedId) : undefined
  if (!current) return nearestCanvasNote(notes, { x: 0, y: 0 })

  const origin = noteCenter(current.position)
  const candidates = notes.filter((note) => {
    if (note.id === current.id) return false
    const center = noteCenter(note.position)
    switch (direction) {
      case "left": return center.x < origin.x
      case "right": return center.x > origin.x
      case "up": return center.y < origin.y
      case "down": return center.y > origin.y
    }
  })
  return candidates.sort((left, right) => {
    const leftCenter = noteCenter(left.position)
    const rightCenter = noteCenter(right.position)
    const leftPrimary = primaryDistance(origin, leftCenter, direction)
    const rightPrimary = primaryDistance(origin, rightCenter, direction)
    if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary
    const leftSecondary = secondaryDistance(origin, leftCenter, direction)
    const rightSecondary = secondaryDistance(origin, rightCenter, direction)
    if (leftSecondary !== rightSecondary) return leftSecondary - rightSecondary
    return compareCanvasNoteIds(left.id, right.id)
  })[0]
}

function compareCanvasNoteIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function noteCenter(position: CanvasCoordinate): CanvasCoordinate {
  return {
    x: position.x + Math.floor(CANVAS_STICKY_NOTE_CARD_WIDTH / 2),
    y: position.y + Math.floor(CANVAS_STICKY_NOTE_CARD_HEIGHT / 2),
  }
}

function distanceSquared(left: CanvasCoordinate, right: CanvasCoordinate): number {
  const dx = left.x - right.x
  const dy = left.y - right.y
  return dx * dx + dy * dy
}

function primaryDistance(
  origin: CanvasCoordinate,
  candidate: CanvasCoordinate,
  direction: CanvasDirection,
): number {
  return direction === "left" || direction === "right"
    ? Math.abs(candidate.x - origin.x)
    : Math.abs(candidate.y - origin.y)
}

function secondaryDistance(
  origin: CanvasCoordinate,
  candidate: CanvasCoordinate,
  direction: CanvasDirection,
): number {
  return direction === "left" || direction === "right"
    ? Math.abs(candidate.y - origin.y)
    : Math.abs(candidate.x - origin.x)
}

export function canvasCoordinateToScreen(
  coordinate: CanvasCoordinate,
  viewport: CanvasCoordinate,
): CanvasCoordinate {
  return {
    x: coordinate.x - viewport.x,
    y: coordinate.y - viewport.y,
  }
}

export function canvasRectIntersectsViewport(
  rect: CanvasRect,
  viewport: CanvasCoordinate,
  viewportSize: CanvasViewportSize,
): boolean {
  validateViewportSize(viewportSize)
  return (
    rect.left < viewport.x + viewportSize.width &&
    rect.left + rect.width > viewport.x &&
    rect.top < viewport.y + viewportSize.height &&
    rect.top + rect.height > viewport.y
  )
}

export function getCanvasStickyNoteCardHeight(lineCount: number): number {
  if (!Number.isInteger(lineCount) || lineCount < 1) {
    throw new RangeError("Sticky Note line count must be a positive integer")
  }
  return lineCount + CANVAS_STICKY_NOTE_CARD_VERTICAL_OVERHEAD
}

export function applyCanvasNavigation(
  state: CanvasNavigationState,
  direction: CanvasDirection,
  viewportSize: CanvasViewportSize,
  options: { pan?: boolean } = {},
): CanvasNavigationState {
  validateViewportSize(viewportSize)

  const delta = directionDelta(direction)
  if (options.pan) {
    return {
      cursor: { ...state.cursor },
      viewport: {
        x: clampViewportCoordinate(state.viewport.x + delta.x, viewportSize.width),
        y: clampViewportCoordinate(state.viewport.y + delta.y, viewportSize.height),
      },
    }
  }

  const cursor = {
    x: clampCoordinate(state.cursor.x + delta.x),
    y: clampCoordinate(state.cursor.y + delta.y),
  }

  return {
    cursor,
    viewport: {
      x: followCursor(cursor.x, state.viewport.x, viewportSize.width),
      y: followCursor(cursor.y, state.viewport.y, viewportSize.height),
    },
  }
}

function directionDelta(direction: CanvasDirection): CanvasCoordinate {
  switch (direction) {
    case "up":
      return { x: 0, y: -1 }
    case "down":
      return { x: 0, y: 1 }
    case "left":
      return { x: -1, y: 0 }
    case "right":
      return { x: 1, y: 0 }
  }
}

function followCursor(cursor: number, viewportStart: number, size: number): number {
  const viewportEnd = viewportStart + size - 1
  if (cursor < viewportStart) {
    return cursor
  }
  if (cursor > viewportEnd) {
    return cursor - size + 1
  }
  return viewportStart
}

function clampCoordinate(value: number): number {
  return Math.max(CANVAS_MIN_COORDINATE, Math.min(CANVAS_MAX_COORDINATE, value))
}

function clampViewportCoordinate(value: number, size: number): number {
  const maximumStart = Math.max(
    CANVAS_MIN_COORDINATE,
    CANVAS_MAX_COORDINATE - size + 1,
  )
  return Math.max(CANVAS_MIN_COORDINATE, Math.min(maximumStart, value))
}

function validateViewportSize(size: CanvasViewportSize): void {
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width < 1 ||
    size.height < 1
  ) {
    throw new RangeError("Canvas viewport dimensions must be positive integers")
  }
}
