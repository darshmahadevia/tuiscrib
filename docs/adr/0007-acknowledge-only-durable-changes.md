# Acknowledge only durably stored shared changes

The terminal treats every published shared mutation as accepted only after the authoritative service has durably persisted and acknowledged it. Text is published in short debounced snapshots, preserving a clear durability promise without committing every keystroke separately.
