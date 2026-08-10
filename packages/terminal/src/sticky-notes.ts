import { splitUserPerceivedCharacters, STICKY_NOTE_WIDTH } from "@tuiscrib/contracts"

export { STICKY_NOTE_WIDTH }

export function wrapStickyNoteText(
  text: string,
  width = STICKY_NOTE_WIDTH,
): string[] {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError("Sticky Note width must be a positive integer")
  }

  const lines: string[] = []
  for (const sourceLine of text.split("\n")) {
    if (sourceLine.length === 0) {
      lines.push("")
      continue
    }

    let line = ""
    let lineWidth = 0
    for (const segment of splitUserPerceivedCharacters(sourceLine)) {
      const segmentWidth = Bun.stringWidth(segment)
      if (line.length > 0 && lineWidth + segmentWidth > width) {
        lines.push(line)
        line = ""
        lineWidth = 0
      }
      line += segment
      lineWidth += segmentWidth
    }
    lines.push(line)
  }

  return lines.length > 0 ? lines : [""]
}
