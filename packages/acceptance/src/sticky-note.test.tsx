import { afterAll, beforeAll, expect, test } from "bun:test"
import { act } from "react"

import {
  MAX_STICKY_NOTE_CHARACTERS,
  type BoardCommandError,
  type BoardSnapshot,
  type BoardSummary,
} from "@tuiscrib/contracts"
import {
  createBoardClient,
  STICKY_NOTE_TEXT_DEBOUNCE_MS,
  type BoardConnection,
} from "@tuiscrib/terminal"

import {
  AcceptanceHarness,
  createMemoryCredentialStore,
  type TerminalClient,
} from "./harness.tsx"

let harness: AcceptanceHarness | null = null

type RawBoardClient = {
  connection: BoardConnection
  snapshots: BoardSnapshot[]
  claims: Array<{ stickyNoteId: string; claimId: string }>
  deleted: Array<{ revision: number; stickyNoteId: string }>
  moved: Array<{ revision: number; stickyNote: { id: string } }>
  errors: BoardCommandError[]
}

beforeAll(async () => {
  harness = await AcceptanceHarness.start()
}, { timeout: 120_000 })

afterAll(async () => {
  await harness?.dispose()
}, { timeout: 30_000 })

test("renders one durable Sticky Note and its attribution in two live terminals", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }
  const ownerCredential = await registerUser("sticky_owner")
  const memberCredential = await registerUser("sticky_member")
  const created = await requestJson<{ board: BoardSummary; joinCode: string }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sticky Notes Board" }),
    },
  )
  expect(created.status).toBe(201)

  const joined = await requestJson<{ board: BoardSummary }>(
    "/boards/join",
    memberCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: created.body.joinCode }),
    },
  )
  expect(joined.status).toBe(201)

  const owner = await harness.addShellClient(
    "sticky-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/owner"),
    undefined,
    {
      schedule: (callback, delayMs) => harness?.clock.setTimeout(callback, delayMs),
      cancel: (handle) => harness?.clock.clearTimeout(handle as number),
    },
  )
  const member = await harness.addShellClient(
    "sticky-member",
    createMemoryCredentialStore(memberCredential, "memory://sticky/member"),
  )

  await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
  await waitForFrame(member, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(owner, created.body.board.name)
  await openSelectedBoard(member, created.body.board.name)
  await waitForFrame(
    owner,
    (frame) => frame.includes("sticky_owner · viewing") && frame.includes("sticky_member · viewing"),
  )
  await waitForFrame(
    member,
    (frame) => frame.includes("sticky_owner · viewing") && frame.includes("sticky_member · viewing"),
  )

  await act(async () => {
    owner.setup.mockInput.pressKey("n")
    await owner.setup.renderOnce()
  })
  const provisional = await waitForFrame(
    owner,
    (frame) => frame.includes("Provisional Sticky Note") && frame.includes("authority") && frame.includes("granted"),
  )
  expect(provisional).toContain("sticky_owner · creating")
  expect(provisional).toContain("Color yellow")

  await act(async () => {
    await owner.setup.mockInput.typeText("durable first note")
    await owner.setup.renderOnce()
  })
  expect(owner.setup.captureCharFrame()).toContain("Sticky Notes: 0")
  await act(async () => {
    harness?.clock.advance(STICKY_NOTE_TEXT_DEBOUNCE_MS)
    await owner.setup.renderOnce()
  })

  const ownerFrame = await waitForFrame(
    owner,
    (frame) => frame.includes("durable first note") && frame.includes("Authored by sticky_owner"),
  )
  expect(ownerFrame).toContain("Sticky Note")
  expect(ownerFrame).toContain("sticky_owner · editing")
  expect(ownerFrame).toContain("Last edit by sticky_owner")

  const memberFrame = await waitForFrame(
    member,
    (frame) => frame.includes("durable first note") && frame.includes("Authored by sticky_owner"),
  )
  expect(memberFrame).toContain("Sticky Notes: 1")
  expect(memberFrame).toContain("sticky_owner · editing")
  expect(memberFrame).toContain("Board revision: 1")
})

test("recolors a selected Sticky Note from an accessible picker without taking the text Edit Claim", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }

  const ownerCredential = await registerUser("color19_owner")
  const memberCredential = await registerUser("color19_member")
  const created = await requestJson<{ board: BoardSummary; joinCode: string }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Color Picker Board" }),
    },
  )
  expect(created.status).toBe(201)
  const joined = await requestJson<{ board: BoardSummary }>(
    "/boards/join",
    memberCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: created.body.joinCode }),
    },
  )
  expect(joined.status).toBe(201)

  const owner = await harness.addShellClient(
    "color19-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/color19-owner"),
    undefined,
    {
      schedule: (callback, delayMs) => harness?.clock.setTimeout(callback, delayMs),
      cancel: (handle) => harness?.clock.clearTimeout(handle as number),
    },
  )
  const member = await harness.addShellClient(
    "color19-member",
    createMemoryCredentialStore(memberCredential, "memory://sticky/color19-member"),
  )

  try {
    await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
    await waitForFrame(member, (frame) => frame.includes("Terminal Session restored"))
    await openSelectedBoard(owner, created.body.board.name)
    await openSelectedBoard(member, created.body.board.name)
    await waitForFrame(owner, (frame) => frame.includes("color19_owner · viewing"))
    await waitForFrame(member, (frame) => frame.includes("color19_member · viewing"))

    await act(async () => {
      owner.setup.mockInput.pressKey("n")
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("Provisional Sticky Note") && frame.includes("authority") && frame.includes("granted"))
    await act(async () => {
      await owner.setup.mockInput.typeText("colorable note")
      harness?.clock.advance(STICKY_NOTE_TEXT_DEBOUNCE_MS)
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("colorable note") && frame.includes("Board revision: 1"))
    await waitForFrame(member, (frame) => frame.includes("colorable note") && frame.includes("Board revision: 1"))

    await act(async () => {
      owner.setup.mockInput.pressEscape()
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("color19_owner · viewing"))

    await act(async () => {
      member.setup.mockInput.pressKey("c")
      await member.setup.renderOnce()
    })
    const picker = await waitForFrame(
      member,
      (frame) => frame.includes("Color picker") && frame.includes("1 amber") && frame.includes("8 yellow"),
    )
    expect(picker).toContain("Color carries no workflow meaning")
    expect(picker).toContain("Current: yellow")
    expect(picker).toContain("Escape cancel")

    await act(async () => {
      member.setup.mockInput.pressEscape()
      await member.setup.renderOnce()
    })
    const cancelled = await waitForFrame(
      member,
      (frame) => frame.includes("Board revision: 1") && frame.includes("Color yellow"),
    )
    expect(cancelled).not.toContain("Color picker · Sticky Note")

    await act(async () => {
      owner.setup.mockInput.pressEnter()
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("Established Sticky Note") && frame.includes("Claim granted"))

    await act(async () => {
      member.setup.mockInput.pressKey("c")
      await member.setup.renderOnce()
    })
    await waitForFrame(member, (frame) => frame.includes("Color picker") && frame.includes("Current: yellow"))
    await act(async () => {
      member.setup.mockInput.pressKey("4")
      await member.setup.renderOnce()
    })

    const memberGreen = await waitForFrame(
      member,
      (frame) => frame.includes("Board revision: 2") && frame.includes("Color green"),
    )
    expect(memberGreen).toContain("color19_owner · editing")
    expect(memberGreen).not.toContain("Color picker · Sticky Note")
    const ownerGreen = await waitForFrame(
      owner,
      (frame) => frame.includes("Board revision: 2") && frame.includes("Color green"),
    )
    expect(ownerGreen).toContain("Established Sticky Note")
    expect(ownerGreen).toContain("color19_owner · editing")
    expect(ownerGreen).toContain("colorable note")

    await act(async () => {
      owner.setup.mockInput.pressEscape()
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("color19_owner · viewing"))

    await act(async () => {
      owner.setup.mockInput.pressKey("c")
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("Color picker") && frame.includes("Current: green"))
    await act(async () => {
      owner.setup.mockInput.pressKey("6")
      await owner.setup.renderOnce()
    })

    const ownerRed = await waitForFrame(
      owner,
      (frame) => frame.includes("Board revision: 3") && frame.includes("Color red"),
    )
    const memberRed = await waitForFrame(
      member,
      (frame) => frame.includes("Board revision: 3") && frame.includes("Color red"),
    )
    expect(ownerRed).toContain("colorable note")
    expect(memberRed).toContain("colorable note")

    await act(async () => {
      await harness?.restartService()
    })
    await waitForFrame(owner, (frame) => frame.includes("Connection: RECONNECTING"))
    await waitForFrame(member, (frame) => frame.includes("Connection: RECONNECTING"))
    const ownerAfterReconnect = await waitForFrame(
      owner,
      (frame) => frame.includes("Board revision: 3") && frame.includes("Color red"),
    )
    const memberAfterReconnect = await waitForFrame(
      member,
      (frame) => frame.includes("Board revision: 3") && frame.includes("Color red"),
    )
    expect(ownerAfterReconnect).toContain("colorable note")
    expect(memberAfterReconnect).toContain("colorable note")
  } finally {
    await harness.disposeClient(owner)
    await harness.disposeClient(member)
  }
})

test("identifies the Member holding an established Edit Claim in the blocked terminal", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }

  const ownerCredential = await registerUser("claim_owner")
  const memberCredential = await registerUser("claim_member")
  const created = await requestJson<{ board: BoardSummary; joinCode: string }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Claim Holder Board" }),
    },
  )
  const joined = await requestJson<{ board: BoardSummary }>(
    "/boards/join",
    memberCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: created.body.joinCode }),
    },
  )
  expect(created.status).toBe(201)
  expect(joined.status).toBe(201)

  const owner = await harness.addShellClient(
    "claim-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/claim-owner"),
    undefined,
    {
      schedule: (callback, delayMs) => harness?.clock.setTimeout(callback, delayMs),
      cancel: (handle) => harness?.clock.clearTimeout(handle as number),
    },
  )
  const member = await harness.addShellClient(
    "claim-member",
    createMemoryCredentialStore(memberCredential, "memory://sticky/claim-member"),
  )

  try {
    await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
    await waitForFrame(member, (frame) => frame.includes("Terminal Session restored"))
    await openSelectedBoard(owner, created.body.board.name)
    await openSelectedBoard(member, created.body.board.name)
    await waitForFrame(owner, (frame) => frame.includes("claim_owner · viewing") && frame.includes("Sticky Notes: 0"))
    await waitForFrame(member, (frame) => frame.includes("claim_owner · viewing") && frame.includes("Sticky Notes: 0"))

    await act(async () => {
      owner.setup.mockInput.pressKey("n")
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("authority") && frame.includes("granted"))
    await act(async () => {
      await owner.setup.mockInput.typeText("claim holder note")
      await owner.setup.renderOnce()
    })
    await act(async () => {
      harness?.clock.advance(STICKY_NOTE_TEXT_DEBOUNCE_MS)
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("claim holder note") && frame.includes("v1"))
    await waitForFrame(member, (frame) => frame.includes("claim holder note") && frame.includes("v1"))

    await act(async () => {
      owner.setup.mockInput.pressEscape()
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("claim_owner · viewing"))
    await waitForFrame(member, (frame) => frame.includes("claim_owner · viewing"))

    await act(async () => {
      member.setup.mockInput.pressEnter()
      await member.setup.renderOnce()
    })
    await waitForFrame(member, (frame) => frame.includes("Established Sticky Note") && frame.includes("Claim granted"))
    await waitForFrame(owner, (frame) => frame.includes("claim_member · editing"))

    await act(async () => {
      owner.setup.mockInput.pressEnter()
      await owner.setup.renderOnce()
    })
    const blocked = await waitForFrame(
      owner,
      (frame) => frame.includes("Edit Claim unavailable") && frame.includes("claim_member"),
    )
    expect(blocked).toContain("claim_member")
    expect(blocked).not.toContain(ownerCredential)
    expect(blocked).not.toContain(memberCredential)
    expect(blocked).toContain("Navigate mode")
  } finally {
    await harness.disposeClient(owner)
    await harness.disposeClient(member)
  }
})

test("deletes a Sticky Note through its Edit Claim across two live terminals", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }

  const ownerCredential = await registerUser("delete23_owner")
  const memberCredential = await registerUser("delete23_member")
  const created = await requestJson<{ board: BoardSummary; joinCode: string }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Delete Sticky Note Board" }),
    },
  )
  const joined = await requestJson<{ board: BoardSummary }>(
    "/boards/join",
    memberCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: created.body.joinCode }),
    },
  )
  expect(created.status).toBe(201)
  expect(joined.status).toBe(201)

  const owner = await harness.addShellClient(
    "delete23-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/delete23-owner"),
    undefined,
    {
      schedule: (callback, delayMs) => harness?.clock.setTimeout(callback, delayMs),
      cancel: (handle) => harness?.clock.clearTimeout(handle as number),
    },
  )
  const member = await harness.addShellClient(
    "delete23-member",
    createMemoryCredentialStore(memberCredential, "memory://sticky/delete23-member"),
  )

  try {
    await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
    await waitForFrame(member, (frame) => frame.includes("Terminal Session restored"))
    await openSelectedBoard(owner, created.body.board.name)
    await openSelectedBoard(member, created.body.board.name)
    await waitForFrame(owner, (frame) => frame.includes("delete23_owner · viewing") && frame.includes("Sticky Notes: 0"))
    await waitForFrame(member, (frame) => frame.includes("delete23_member · viewing") && frame.includes("Sticky Notes: 0"))

    await act(async () => {
      owner.setup.mockInput.pressKey("n")
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("Provisional Sticky Note") && frame.includes("authority") && frame.includes("granted"))
    await act(async () => {
      await owner.setup.mockInput.typeText("delete through edit claim")
      harness?.clock.advance(STICKY_NOTE_TEXT_DEBOUNCE_MS)
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("delete through edit claim") && frame.includes("Board revision: 1"))
    await waitForFrame(member, (frame) => frame.includes("delete through edit claim") && frame.includes("Board revision: 1"))

    await act(async () => {
      owner.setup.mockInput.pressEscape()
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("delete23_owner · viewing"))
    await waitForFrame(member, (frame) => frame.includes("delete23_owner · viewing"))

    await act(async () => {
      member.setup.mockInput.pressEnter()
      await member.setup.renderOnce()
    })
    await waitForFrame(member, (frame) => frame.includes("Established Sticky Note") && frame.includes("Claim granted"))
    await waitForFrame(owner, (frame) => frame.includes("delete23_member · editing"))

    await act(async () => {
      owner.setup.mockInput.pressKey("d")
      await owner.setup.renderOnce()
    })
    const blocked = await waitForFrame(
      owner,
      (frame) => frame.includes("Deletion unavailable") && frame.includes("delete23_member"),
    )
    expect(blocked).toContain("Edit Claim holder: delete23_member")
    expect(blocked).not.toContain("Permanently delete Sticky Note")

    await act(async () => {
      member.setup.mockInput.pressEscape()
      await member.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("delete23_owner · viewing"))
    await waitForFrame(member, (frame) => frame.includes("delete23_member · viewing"))

    await act(async () => {
      owner.setup.mockInput.pressKey("d")
      await owner.setup.renderOnce()
    })
    const confirmation = await waitForFrame(
      owner,
      (frame) => frame.includes("Permanently delete Sticky Note") && frame.includes("delete through edit claim"),
    )
    expect(confirmation).toContain("y permanently delete")
    expect(confirmation).toContain("n cancel + release Edit Claim")
    expect(confirmation).toContain("Escape cancel")

    await act(async () => {
      owner.setup.mockInput.pressKey("n")
      await owner.setup.renderOnce()
    })
    const cancelled = await waitForFrame(
      owner,
      (frame) => frame.includes("Board revision: 1") &&
        frame.includes("Sticky Notes: 1") &&
        frame.includes("delete through edit claim") &&
        !frame.includes("Permanently delete Sticky Note"),
    )
    expect(cancelled).toContain("delete through edit claim")
    expect(cancelled).not.toContain("Permanently delete Sticky Note")
    await waitForFrame(member, (frame) => frame.includes("delete23_owner · viewing") && frame.includes("Board revision: 1"))

    await act(async () => {
      owner.setup.mockInput.pressKey("d")
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("Permanently delete Sticky Note"))
    await act(async () => {
      owner.setup.mockInput.pressKey("y")
      await owner.setup.renderOnce()
    })

    const ownerDeleted = await waitForFrame(
      owner,
      (frame) => frame.includes("Board revision: 2") && frame.includes("Sticky Notes: 0"),
    )
    const memberDeleted = await waitForFrame(
      member,
      (frame) => frame.includes("Board revision: 2") && frame.includes("Sticky Notes: 0"),
    )
    expect(ownerDeleted).not.toContain("delete through edit claim")
    expect(memberDeleted).not.toContain("delete through edit claim")
    expect(ownerDeleted).toContain("delete23_owner · viewing")
    expect(memberDeleted).toContain("delete23_owner · viewing")
  } finally {
    await harness.disposeClient(owner)
    await harness.disposeClient(member)
  }
})

test("resolves two-client Sticky Note delete races by committed Board revision", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }

  const ownerCredential = await registerUser("delete23race_owner")
  const memberCredential = await registerUser("delete23race_member")
  const created = await requestJson<{ board: BoardSummary; joinCode: string }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Delete Race Board" }),
    },
  )
  const joined = await requestJson<{ board: BoardSummary }>(
    "/boards/join",
    memberCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: created.body.joinCode }),
    },
  )
  expect(created.status).toBe(201)
  expect(joined.status).toBe(201)

  const owner = await harness.addShellClient(
    "delete23race-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/delete23race-owner"),
    undefined,
    {
      schedule: (callback, delayMs) => harness?.clock.setTimeout(callback, delayMs),
      cancel: (handle) => harness?.clock.clearTimeout(handle as number),
    },
  )
  const member = await harness.addShellClient(
    "delete23race-member",
    createMemoryCredentialStore(memberCredential, "memory://sticky/delete23race-member"),
  )

  let rawOwner: RawBoardClient | undefined
  let rawMember: RawBoardClient | undefined
  try {
    await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
    await waitForFrame(member, (frame) => frame.includes("Terminal Session restored"))
    await openSelectedBoard(owner, created.body.board.name)
    await openSelectedBoard(member, created.body.board.name)
    await waitForFrame(owner, (frame) => frame.includes("Board revision: 0"))
    await waitForFrame(member, (frame) => frame.includes("Board revision: 0"))

    await createNote("delete23 move-first")
    await act(async () => {
      owner.setup.mockInput.pressEscape()
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("delete23race_owner · viewing"))
    await waitForFrame(member, (frame) => frame.includes("Board revision: 1") && frame.includes("delete23 move-first"))

    await act(async () => {
      owner.setup.mockInput.pressArrow("right")
      await owner.setup.renderOnce()
    })
    await createNote("delete23 delete-first")
    await waitForFrame(owner, (frame) => frame.includes("delete23 delete-first") && frame.includes("Board revision: 2"))
    await waitForFrame(member, (frame) => frame.includes("delete23 delete-first") && frame.includes("Board revision: 2"))
    await act(async () => {
      owner.setup.mockInput.pressEscape()
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("delete23race_owner · viewing"))
    await waitForFrame(member, (frame) => frame.includes("delete23race_member · viewing"))

    await harness.disposeClient(owner)
    await harness.disposeClient(member)

    rawOwner = await openRawBoardClient(ownerCredential)
    rawMember = await openRawBoardClient(memberCredential)
    const initial = rawOwner.snapshots.at(-1)
    expect(initial?.revision).toBe(2)
    expect(initial?.stickyNotes).toHaveLength(2)
    const moveFirstNote = initial?.stickyNotes?.find((note) => note.text === "delete23 move-first")
    const deleteFirstNote = initial?.stickyNotes?.find((note) => note.text === "delete23 delete-first")
    if (!moveFirstNote || !deleteFirstNote) {
      throw new Error("race fixture did not contain both Sticky Notes")
    }

    // Mutation first: the move commits at revision 3; deletion then commits at revision 4.
    rawMember.connection.send({
      type: "move_sticky_note",
      stickyNoteId: moveFirstNote.id,
      direction: "right",
    })
    await waitForRaw(
      rawOwner,
      (client) => client.moved.some((event) => event.stickyNote.id === moveFirstNote.id && event.revision === 3),
      "move-first movement",
    )
    const moveFirstClaim = await claimRawNote(rawOwner, moveFirstNote.id)
    rawOwner.connection.send({
      type: "delete_sticky_note",
      claimId: moveFirstClaim,
      stickyNoteId: moveFirstNote.id,
    })
    await waitForRaw(
      rawMember,
      (client) => client.deleted.some((event) => event.stickyNoteId === moveFirstNote.id && event.revision === 4),
      "move-first deletion",
    )
    await waitForRaw(
      rawOwner,
      (client) => client.snapshots.at(-1)?.revision === 4,
      "move-first authoritative snapshot",
    )
    expect(rawOwner.snapshots.at(-1)?.revision).toBe(4)

    // Delete first: the later move is rejected against the authoritative deleted state.
    const deleteFirstClaim = await claimRawNote(rawOwner, deleteFirstNote.id)
    rawOwner.connection.send({
      type: "delete_sticky_note",
      claimId: deleteFirstClaim,
      stickyNoteId: deleteFirstNote.id,
    })
    await waitForRaw(
      rawMember,
      (client) => client.deleted.some((event) => event.stickyNoteId === deleteFirstNote.id && event.revision === 5),
      "delete-first deletion",
    )
    rawMember.connection.send({
      type: "move_sticky_note",
      stickyNoteId: deleteFirstNote.id,
      direction: "right",
    })
    await waitForRaw(
      rawMember,
      (client) => client.errors.some(
        (error) => error.code === "sticky_note_rejected" && error.error.includes("Position change was rejected"),
      ),
      "invalid later movement rejection",
    )
    await waitForRaw(
      rawMember,
      (client) => client.snapshots.at(-1)?.revision === 5,
      "delete-first authoritative snapshot",
    )
    expect(rawMember.snapshots.at(-1)?.revision).toBe(5)
    expect(rawMember.snapshots.at(-1)?.stickyNotes).toHaveLength(0)
  } finally {
    rawOwner?.connection.close()
    rawMember?.connection.close()
    if (harness.clients.includes(owner)) {
      await harness.disposeClient(owner)
    }
    if (harness.clients.includes(member)) {
      await harness.disposeClient(member)
    }
  }

  async function createNote(text: string): Promise<void> {
    await act(async () => {
      owner.setup.mockInput.pressKey("n")
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes("Provisional Sticky Note") && frame.includes("authority") && frame.includes("granted"))
    await act(async () => {
      await owner.setup.mockInput.typeText(text)
      harness?.clock.advance(STICKY_NOTE_TEXT_DEBOUNCE_MS)
      await owner.setup.renderOnce()
    })
    await waitForFrame(owner, (frame) => frame.includes(text) && frame.includes("Board revision:"))
  }

  async function openRawBoardClient(credential: string): Promise<RawBoardClient> {
    const snapshots: BoardSnapshot[] = []
    const claims: Array<{ stickyNoteId: string; claimId: string }> = []
    const deleted: Array<{ revision: number; stickyNoteId: string }> = []
    const moved: Array<{ revision: number; stickyNote: { id: string } }> = []
    const errors: BoardCommandError[] = []
    const client = createBoardClient(harness!.baseUrl, fetch, undefined, { heartbeatIntervalMs: 0 })
    const openBoard = client.openBoard
    if (!openBoard) {
      throw new Error("Board client does not support Board collaboration")
    }
    const connection = await openBoard(credential, created.body.board.id, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: (error) => {
        throw error
      },
      onClose: () => undefined,
      onStickyNoteEditClaimGranted: (claim) => claims.push(claim),
      onStickyNoteDeleted: (event) => deleted.push(event),
      onStickyNoteMoved: (event) => moved.push(event),
      onCommandError: (error) => errors.push(error),
    })
    const raw = { snapshots, claims, deleted, moved, errors, connection }
    await waitForRaw(raw, (current) => current.snapshots.length > 0, "raw Board snapshot")
    return raw
  }

  async function claimRawNote(client: RawBoardClient, stickyNoteId: string): Promise<string> {
    const claimCount = client.claims.length
    client.connection.send({ type: "begin_sticky_note_edit", stickyNoteId })
    await waitForRaw(
      client,
      (current) => current.claims.length > claimCount && current.claims.some((claim) => claim.stickyNoteId === stickyNoteId),
      `Edit Claim for ${stickyNoteId}`,
    )
    const claim = client.claims.find((current) => current.stickyNoteId === stickyNoteId)
    if (!claim) {
      throw new Error(`Edit Claim was not granted for ${stickyNoteId}`)
    }
    return claim.claimId
  }

  async function waitForRaw(
    client: RawBoardClient,
    predicate: (client: RawBoardClient) => boolean,
    description: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (predicate(client)) {
        return
      }
      await Bun.sleep(5)
    }
    throw new Error(`Timed out waiting for ${description}`)
  }
})

test("edits an established Sticky Note with debounce, flush, attribution, empty text, and restart durability", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }

  const ownerCredential = await registerUser("edit_owner")
  const memberCredential = await registerUser("edit_member")
  const created = await requestJson<{ board: BoardSummary; joinCode: string }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Established Edit Board" }),
    },
  )
  const joined = await requestJson<{ board: BoardSummary }>(
    "/boards/join",
    memberCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: created.body.joinCode }),
    },
  )
  expect(created.status).toBe(201)
  expect(joined.status).toBe(201)

  const owner = await harness.addShellClient(
    "edit-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/edit-owner"),
    undefined,
    {
      schedule: (callback, delayMs) => harness?.clock.setTimeout(callback, delayMs),
      cancel: (handle) => harness?.clock.clearTimeout(handle as number),
    },
  )
  const member = await harness.addShellClient(
    "edit-member",
    createMemoryCredentialStore(memberCredential, "memory://sticky/edit-member"),
  )

  await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
  await waitForFrame(member, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(owner, created.body.board.name)
  await openSelectedBoard(member, created.body.board.name)
  await waitForFrame(owner, (frame) => frame.includes("edit_owner · viewing") && frame.includes("Sticky Notes: 0"))
  await waitForFrame(member, (frame) => frame.includes("edit_owner · viewing") && frame.includes("Sticky Notes: 0"))

  await act(async () => {
    owner.setup.mockInput.pressKey("n")
    await owner.setup.renderOnce()
    await owner.setup.mockInput.typeText("durable edit text")
    await owner.setup.renderOnce()
  })
  await waitForFrame(owner, (frame) => frame.includes("edit_owner · creating"))
  expect(owner.setup.captureCharFrame()).toContain("Sticky Notes: 0")
  await act(async () => {
    harness?.clock.advance(150)
    await owner.setup.renderOnce()
  })
  await waitForFrame(owner, (frame) => frame.includes("durable edit text") && frame.includes("v1"))
  await waitForFrame(member, (frame) => frame.includes("durable edit text") && frame.includes("v1"))

  await act(async () => {
    owner.setup.mockInput.pressEscape()
    await owner.setup.renderOnce()
  })
  await waitForFrame(owner, (frame) => frame.includes("› Sticky Note · (0, 0) · v1") && frame.includes("edit_owner · viewing"))
  await waitForFrame(member, (frame) => frame.includes("edit_owner · viewing") && frame.includes("v1"))

  await act(async () => {
    owner.setup.mockInput.pressEnter()
    await owner.setup.renderOnce()
  })
  await waitForFrame(owner, (frame) =>
    frame.includes("Established Sticky Note") && frame.includes("Claim") && frame.includes("granted"),
  )
  await waitForFrame(member, (frame) => frame.includes("edit_owner · editing"))

  await act(async () => {
    await owner.setup.mockInput.typeText(" revised")
    await owner.setup.renderOnce()
  })
  expect(owner.setup.captureCharFrame()).toContain("durable edit text revised")
  expect(member.setup.captureCharFrame()).toContain("durable edit text")
  await act(async () => {
    harness?.clock.advance(149)
    await owner.setup.renderOnce()
    await member.setup.renderOnce()
  })
  expect(member.setup.captureCharFrame()).toContain("durable edit text")
  expect(member.setup.captureCharFrame()).not.toContain("durable edit text revised")
  await act(async () => {
    owner.setup.mockInput.pressEscape()
    await owner.setup.renderOnce()
  })
  const published = await waitForFrame(
    member,
    (frame) => frame.includes("durable edit text revised") && frame.includes("v2"),
  )
  expect(published).toContain("Last edit by edit_owner")
  expect(published).toContain("Board revision: 2")
  await waitForFrame(owner, (frame) => frame.includes("› Sticky Note · (0, 0) · v2") && frame.includes("edit_owner · viewing"))
  await waitForFrame(member, (frame) => frame.includes("edit_owner · viewing") && frame.includes("v2"))

  await act(async () => {
    owner.setup.mockInput.pressEnter()
    await owner.setup.renderOnce()
  })
  await waitForFrame(owner, (frame) =>
    frame.includes("Established Sticky Note") && frame.includes("Claim") && frame.includes("granted"),
  )
  const textToClear = "durable edit text revised"
  await act(async () => {
    for (let index = 0; index < textToClear.length; index += 1) {
      owner.setup.mockInput.pressBackspace()
      await owner.setup.renderOnce()
    }
  })
  expect(owner.setup.captureCharFrame()).toContain("Established Sticky Note")
  expect(owner.setup.captureCharFrame()).not.toContain(textToClear)
  await act(async () => {
    harness?.clock.advance(150)
    await owner.setup.renderOnce()
  })
  const publishedEmpty = await waitForFrame(
    member,
    (frame) => frame.includes("Board revision: 3") && frame.includes("v3") && frame.includes("Sticky Notes: 1"),
  )
  expect(publishedEmpty).toContain("Last edit by edit_owner")
  expect(publishedEmpty).not.toContain(textToClear)

  await act(async () => {
    owner.setup.mockInput.pressEscape()
    await owner.setup.renderOnce()
  })
  await waitForFrame(owner, (frame) => frame.includes("› Sticky Note · (0, 0) · v3") && frame.includes("edit_owner · viewing"))

  await harness.restartService()
  await harness.disposeClient(owner)
  await harness.disposeClient(member)
  const reopened = await harness.addShellClient(
    "edit-owner-reopened",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/edit-owner-reopened"),
  )
  await waitForFrame(reopened, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(reopened, created.body.board.name)
  const restarted = await waitForFrame(
    reopened,
    (frame) => frame.includes("Board revision: 3") && frame.includes("Sticky Notes: 1") && frame.includes("v3"),
  )
  expect(restarted).toContain("Last edit by edit_owner")
  await harness.disposeClient(reopened)
})

test("discards an empty provisional Sticky Note and transitions Presence back to viewing", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }

  const ownerCredential = await registerUser("empty_owner")
  const memberCredential = await registerUser("empty_member")
  const created = await requestJson<{ board: BoardSummary; joinCode: string }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Empty Provisional Board" }),
    },
  )
  const joined = await requestJson<{ board: BoardSummary }>(
    "/boards/join",
    memberCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode: created.body.joinCode }),
    },
  )
  expect(created.status).toBe(201)
  expect(joined.status).toBe(201)

  const owner = await harness.addShellClient(
    "empty-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/empty-owner"),
  )
  const member = await harness.addShellClient(
    "empty-member",
    createMemoryCredentialStore(memberCredential, "memory://sticky/empty-member"),
  )
  await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
  await waitForFrame(member, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(owner, created.body.board.name)
  await openSelectedBoard(member, created.body.board.name)
  await waitForFrame(owner, (frame) => frame.includes("empty_owner · viewing") && frame.includes("Sticky Notes: 0"))

  await act(async () => {
    owner.setup.mockInput.pressKey("n")
    await owner.setup.renderOnce()
  })
  await waitForFrame(owner, (frame) => frame.includes("empty_owner · creating") && frame.includes("Sticky Notes: 0"))

  await act(async () => {
    owner.setup.mockInput.pressEscape()
    await owner.setup.renderOnce()
  })
  const discarded = await waitForFrame(
    member,
    (frame) => frame.includes("empty_owner · viewing") && frame.includes("Sticky Notes: 0"),
  )
  expect(discarded).toContain("Board revision: 0")
})

test("renders a clear editor error and rejects text beyond 2,000 user-perceived characters", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }

  const ownerCredential = await registerUser("limit_owner")
  const created = await requestJson<{ board: BoardSummary }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Text Limit Board" }),
    },
  )
  expect(created.status).toBe(201)

  const owner = await harness.addShellClient(
    "limit-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/limit-owner"),
    undefined,
    {
      schedule: (callback, delayMs) => harness?.clock.setTimeout(callback, delayMs),
      cancel: (handle) => harness?.clock.clearTimeout(handle as number),
    },
  )
  await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(owner, created.body.board.name)
  await waitForFrame(owner, (frame) => frame.includes("limit_owner · viewing"))

  await act(async () => {
    owner.setup.mockInput.pressKey("n")
    await owner.setup.renderOnce()
  })
  await waitForFrame(
    owner,
    (frame) =>
      frame.includes("limit_owner · creating") &&
      frame.includes("Provisional Sticky Note") &&
      frame.includes("authority") &&
      frame.includes("granted"),
  )
  const overLimitText = "e\u0301".repeat(MAX_STICKY_NOTE_CHARACTERS + 1)
  await act(async () => {
    await owner.setup.mockInput.pasteBracketedText(overLimitText)
    await owner.setup.renderOnce()
  })
  const rejected = await waitForFrame(
    owner,
    (frame) => frame.includes("2,000 user-perceived Unicode characters"),
  )
  expect(rejected).toContain("Sticky Notes: 0")

  await act(async () => {
    owner.setup.mockInput.pressEscape()
    await owner.setup.renderOnce()
  })
  const afterDiscard = await waitForFrame(
    owner,
    (frame) => frame.includes("Sticky Notes: 0") && frame.includes("Board revision: 0"),
  )
  expect(afterDiscard).not.toContain("Sticky Note ·")
})

test("restarting the hosted service cannot orphan an empty provisional Sticky Note", async () => {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }
  const activeHarness = harness

  const ownerCredential = await registerUser("restart_owner")
  const created = await requestJson<{ board: BoardSummary }>(
    "/boards",
    ownerCredential,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Restart Provisional Board" }),
    },
  )
  expect(created.status).toBe(201)

  const owner = await harness.addShellClient(
    "restart-owner",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/restart-owner"),
  )
  await waitForFrame(owner, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(owner, created.body.board.name)
  await waitForFrame(owner, (frame) => frame.includes("restart_owner · viewing"))
  await act(async () => {
    owner.setup.mockInput.pressKey("n")
    await owner.setup.renderOnce()
  })
  await waitForFrame(owner, (frame) => frame.includes("restart_owner · creating"))

  await act(async () => {
    await activeHarness.restartService()
    await activeHarness.disposeClient(owner)
  })

  const reopened = await harness.addShellClient(
    "restart-owner-reopened",
    createMemoryCredentialStore(ownerCredential, "memory://sticky/restart-owner-reopened"),
  )
  await waitForFrame(reopened, (frame) => frame.includes("Terminal Session restored"))
  await openSelectedBoard(reopened, created.body.board.name)
  const snapshot = await waitForFrame(
    reopened,
    (frame) => frame.includes("Board revision: 0") && frame.includes("Sticky Notes: 0"),
  )
  expect(snapshot).not.toContain("Provisional Sticky Note")
})

async function openSelectedBoard(client: TerminalClient, boardName: string): Promise<void> {
  await act(async () => {
    client.setup.mockInput.pressKey("b")
    await client.setup.renderOnce()
  })
  await waitForFrame(client, (frame) => frame.includes("Board list") && frame.includes(boardName))
  await act(async () => {
    client.setup.mockInput.pressKey("o")
    await client.setup.renderOnce()
  })
}

async function waitForFrame(
  client: TerminalClient,
  predicate: (frame: string) => boolean,
): Promise<string> {
  let lastFrame = ""
  let matchedFrame: string | undefined
  await act(async () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      await Bun.sleep(5)
      await client.setup.renderOnce()
      lastFrame = client.setup.captureCharFrame()
      if (predicate(lastFrame)) {
        matchedFrame = lastFrame
        return
      }
    }
  })
  if (matchedFrame !== undefined) {
    return matchedFrame
  }
  throw new Error(`Timed out waiting for ${client.label} rendered frame\n${lastFrame}`)
}

async function registerUser(username: string): Promise<string> {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }
  const response = await fetch(`${harness.baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username,
      password: "correct horse",
      confirmation: "correct horse",
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json() as { sessionCredential: string }).sessionCredential
}

async function requestJson<T>(
  path: string,
  credential: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  if (!harness) {
    throw new Error("acceptance harness did not start")
  }
  const response = await fetch(`${harness.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${credential}`,
      ...init.headers,
    },
  })
  return { status: response.status, body: await response.json() as T }
}
