export const STICKY_NOTE_TEXT_DEBOUNCE_MS = 150

export type StickyNoteTimer = {
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

export type StickyNoteDebouncerOptions = Partial<StickyNoteTimer> & {
  delayMs?: number
  publish(text: string): void
}

export type StickyNoteDebouncer = {
  schedule(text: string): void
  flush(): void
  cancel(): void
}

export function createStickyNoteDebouncer({
  delayMs = STICKY_NOTE_TEXT_DEBOUNCE_MS,
  schedule: scheduleTimer = (callback, delay) => setTimeout(callback, delay),
  cancel: cancelTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  publish,
}: StickyNoteDebouncerOptions): StickyNoteDebouncer {
  let pendingText: string | null = null
  let timer: unknown | null = null

  const clearTimer = () => {
    if (timer === null) {
      return
    }
    cancelTimer(timer)
    timer = null
  }

  const publishPending = () => {
    clearTimer()
    const text = pendingText
    pendingText = null
    if (text !== null) {
      publish(text)
    }
  }

  return {
    schedule(text) {
      clearTimer()
      pendingText = text
      timer = scheduleTimer(publishPending, delayMs)
    },
    flush: publishPending,
    cancel() {
      clearTimer()
      pendingText = null
    },
  }
}
