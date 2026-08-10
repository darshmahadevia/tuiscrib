# Use exclusive claims for sticky-note text editing

Only one terminal session may edit or delete a sticky note at a time, while other members may still move, reorder, or recolor it. Typing publishes durably stored full-text snapshots after roughly 150 milliseconds of idle input and flushes when Edit mode exits; a disconnected session retains its claim for 30 seconds unless a service restart or authorization loss ends it first. This avoids merged-text complexity and excessive per-key database writes while keeping collaboration visibly live.
