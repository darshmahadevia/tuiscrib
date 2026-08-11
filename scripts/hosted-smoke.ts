import {
  createAuthClient,
  createBoardClient,
  createHealthClient,
  ServiceRequestError,
  type BoardConnection,
} from "../packages/terminal/src/client.ts"
import { redactServiceError } from "../packages/service/src/config.ts"
import type {
  BoardSnapshot,
  StickyNoteCreated,
  StickyNoteCreationClaimGranted,
  StickyNoteMoved,
} from "../packages/contracts/src/index.ts"

type SmokeProbe = {
  connection: BoardConnection
  snapshots: BoardSnapshot[]
  claims: StickyNoteCreationClaimGranted[]
  created: StickyNoteCreated[]
  moved: StickyNoteMoved[]
  authorizationLosses: string[]
  errors: Error[]
}

const DEFAULT_TIMEOUT_MS = 120_000

async function main(): Promise<void> {
  const baseUrl = getArgument("--url") ?? process.env.TUISCRIB_URL
  if (!baseUrl) {
    throw new Error("Hosted smoke requires --url or TUISCRIB_URL.")
  }

  const parsedUrl = new URL(baseUrl)
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Hosted smoke URL must use http or https.")
  }
  if (parseBoolean(process.env.TUISCRIB_SMOKE_REQUIRE_HTTPS) && parsedUrl.protocol !== "https:") {
    throw new Error("Hosted smoke requires an HTTPS URL when TUISCRIB_SMOKE_REQUIRE_HTTPS=true.")
  }

  const timeoutMs = parseTimeout(process.env.TUISCRIB_SMOKE_TIMEOUT_MS)
  const health = await withTimeout(
    createHealthClient(parsedUrl.toString()).checkHealth(),
    timeoutMs,
    "health readiness",
  )
  if (health.status !== "ready" || health.database !== "ready") {
    throw new Error("Health readiness did not report a ready service and database.")
  }

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8)
  const password = "hosted smoke password"
  const ownerUsername = `smoke_owner_${suffix}`
  const memberUsername = `smoke_member_${suffix}`
  const auth = createAuthClient(parsedUrl.toString())
  const boards = createBoardClient(parsedUrl.toString())
  const owner = await withTimeout(
    auth.register({ username: ownerUsername, password, confirmation: password }),
    timeoutMs,
    "owner registration",
  )
  const member = await withTimeout(
    auth.register({ username: memberUsername, password, confirmation: password }),
    timeoutMs,
    "member registration",
  )

  const created = await withTimeout(
    boards.createBoard(owner.sessionCredential, { name: `Hosted Smoke ${suffix}` }),
    timeoutMs,
    "Board creation",
  )
  await withTimeout(
    boards.joinBoard(member.sessionCredential, { joinCode: created.joinCode }),
    timeoutMs,
    "Membership join",
  )

  let ownerProbe: SmokeProbe | undefined
  let memberProbe: SmokeProbe | undefined
  try {
    ownerProbe = await openProbe(
      boards,
      owner.sessionCredential,
      created.board.id,
      timeoutMs,
    )
    memberProbe = await openProbe(
      boards,
      member.sessionCredential,
      created.board.id,
      timeoutMs,
    )
    await waitFor(
      () => ownerProbe!.snapshots.some((snapshot) => snapshot.presence.length === 2),
      timeoutMs,
      "two-client Presence",
    )

    const provisionalId = crypto.randomUUID()
    ownerProbe.connection.send({
      type: "begin_sticky_note",
      provisionalId,
      position: { x: 0, y: 0 },
      color: "yellow",
    })
    await waitFor(
      () => ownerProbe!.claims.some((claim) => claim.provisionalId === provisionalId),
      timeoutMs,
      "Sticky Note creation authority",
    )
    const claim = ownerProbe.claims.find((item) => item.provisionalId === provisionalId)
    if (!claim) {
      throw new Error("Sticky Note creation authority was not returned.")
    }

    const text = `hosted smoke note ${suffix}`
    ownerProbe.connection.send({
      type: "publish_sticky_note",
      claimId: claim.claimId,
      provisionalId,
      text,
    })
    await waitFor(
      () => memberProbe!.created.some((event) => event.stickyNote.text === text),
      timeoutMs,
      "durable Sticky Note observation by the second client",
    )

    const createdNote = ownerProbe.created.find((event) => event.stickyNote.text === text)?.stickyNote ??
      memberProbe.created.find((event) => event.stickyNote.text === text)?.stickyNote
    if (!createdNote) {
      throw new Error("Hosted smoke could not identify the durable Sticky Note.")
    }
    memberProbe.connection.send({
      type: "move_sticky_note",
      stickyNoteId: createdNote.id,
      direction: "right",
    })
    await waitFor(
      () => ownerProbe!.moved.some((event) =>
        event.stickyNote.id === createdNote.id && event.stickyNote.position.x === 1),
      timeoutMs,
      "durable Sticky Note movement observation by the first client",
    )
    await waitFor(
      () => ownerProbe!.snapshots.some((snapshot) => snapshot.presence.some((presence) =>
        presence.member.username === memberUsername && presence.activity === "moving")),
      timeoutMs,
      "moving Presence",
    )
    await waitFor(
      () => ownerProbe!.snapshots.some((snapshot) => snapshot.presence.some((presence) =>
        presence.member.username === memberUsername && presence.activity === "viewing")),
      timeoutMs,
      "movement Presence expiry",
    )

    memberProbe.connection.close()
    memberProbe = await openProbe(
      boards,
      member.sessionCredential,
      created.board.id,
      timeoutMs,
    )
    await waitFor(
      () => memberProbe!.snapshots.some((snapshot) =>
        snapshot.stickyNotes?.some((note) => note.text === text && note.position.x === 1)),
      timeoutMs,
      "durable Sticky Note after reconnect",
    )

    await withTimeout(
      boards.deleteBoard(owner.sessionCredential, created.board.id),
      timeoutMs,
      "transactional Board deletion",
    )
    await waitFor(
      () => ownerProbe!.authorizationLosses.length === 1 && memberProbe!.authorizationLosses.length === 1,
      timeoutMs,
      "authorization loss on both connected clients",
    )

    const deletedOwnerBoards = await withTimeout(
      boards.listBoards(owner.sessionCredential),
      timeoutMs,
      "Owner Board list after deletion",
    )
    const deletedMemberBoards = await withTimeout(
      boards.listBoards(member.sessionCredential),
      timeoutMs,
      "Member Board list after deletion",
    )
    if (deletedOwnerBoards.boards.length !== 0 || deletedMemberBoards.boards.length !== 0) {
      throw new Error("Deleted Board remained visible in a Board list.")
    }

    let openAfterDeletionError: unknown
    try {
      const staleConnection = await withTimeout(
        boards.openBoard!(member.sessionCredential, created.board.id, {
          onSnapshot: () => undefined,
          onError: () => undefined,
          onClose: () => undefined,
        }),
        timeoutMs,
        "deleted Board WebSocket preflight",
      )
      staleConnection.close()
      throw new Error("Deleted Board WebSocket preflight unexpectedly succeeded.")
    } catch (error) {
      openAfterDeletionError = error
    }
    if (!(openAfterDeletionError instanceof ServiceRequestError) || openAfterDeletionError.status !== 404) {
      throw new Error("Deleted Board WebSocket preflight did not return 404.")
    }
    if (JSON.stringify(openAfterDeletionError.details).includes(created.board.name) ||
      JSON.stringify(openAfterDeletionError.details).includes(created.joinCode)) {
      throw new Error("Deleted Board WebSocket preflight disclosed deleted state.")
    }

    let joinAfterDeletionError: unknown
    try {
      await withTimeout(
        boards.joinBoard(member.sessionCredential, { joinCode: created.joinCode }),
        timeoutMs,
        "deleted Board Join Code redemption",
      )
    } catch (error) {
      joinAfterDeletionError = error
    }
    if (!(joinAfterDeletionError instanceof ServiceRequestError) || joinAfterDeletionError.status !== 404) {
      throw new Error("Deleted Board Join Code did not return 404.")
    }
    if (JSON.stringify(joinAfterDeletionError.details).includes(created.board.name) ||
      JSON.stringify(joinAfterDeletionError.details).includes(created.joinCode)) {
      throw new Error("Deleted Board Join Code disclosed deleted state.")
    }

    const finalHealth = await withTimeout(
      createHealthClient(parsedUrl.toString()).checkHealth(),
      timeoutMs,
      "final health readiness",
    )
    if (finalHealth.status !== "ready" || finalHealth.database !== "ready") {
      throw new Error("Final health readiness did not report a ready service and database.")
    }
    console.log("Hosted smoke passed: health, HTTPS/WebSocket upgrade, two-client Membership, and durable Sticky Note state.")
  } finally {
    ownerProbe?.connection.close()
    memberProbe?.connection.close()
  }
}

async function openProbe(
  boards: ReturnType<typeof createBoardClient>,
  credential: string,
  boardId: string,
  timeoutMs: number,
): Promise<SmokeProbe> {
  if (!boards.openBoard) {
    throw new Error("The terminal Board client does not expose collaboration.")
  }
  const probe: Omit<SmokeProbe, "connection"> & { connection?: BoardConnection } = {
    snapshots: [],
    claims: [],
    created: [],
    moved: [],
    authorizationLosses: [],
    errors: [],
  }
  const connectionPromise = boards.openBoard(credential, boardId, {
    onSnapshot: (snapshot) => probe.snapshots.push(snapshot),
    onError: (error) => probe.errors.push(error),
    onClose: () => undefined,
    onStickyNoteCreationClaimGranted: (claim) => probe.claims.push(claim),
    onStickyNoteCreated: (event) => probe.created.push(event),
    onStickyNoteMoved: (event) => probe.moved.push(event),
    onAuthorizationLost: (reason) => probe.authorizationLosses.push(reason),
  })
  try {
    probe.connection = await withTimeout(connectionPromise, timeoutMs, "WebSocket upgrade")
    await waitFor(() => probe.snapshots.length > 0, timeoutMs, "initial Board snapshot")
    if (probe.errors.length > 0) {
      throw probe.errors[0]
    }
    return probe as SmokeProbe
  } catch (error) {
    probe.connection?.close()
    throw error
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`)
    }
    await Bun.sleep(25)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out during ${label}.`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_TIMEOUT_MS
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1_000 || value > 600_000) {
    throw new Error("TUISCRIB_SMOKE_TIMEOUT_MS must be an integer from 1000 through 600000.")
  }
  return value
}

function parseBoolean(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "true"
}

function redactError(error: unknown): string {
  return redactServiceError(error)
}

try {
  await main()
} catch (error) {
  console.error(`Hosted smoke failed: ${redactError(error)}`)
  process.exitCode = 1
}
