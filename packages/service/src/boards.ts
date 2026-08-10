import { createHash, randomBytes } from "node:crypto"

import {
  boardIdentifierSchema,
  boardListResponseSchema,
  createBoardRequestSchema,
  createBoardResponseSchema,
  joinCodeSchema,
  joinBoardRequestSchema,
  joinBoardResponseSchema,
  leaveBoardResponseSchema,
  renameBoardRequestSchema,
  renameBoardResponseSchema,
  rotateJoinCodeResponseSchema,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_UNGROUPED_LENGTH,
  MAX_BOARD_MEMBERS,
  serviceErrorSchema,
  type BoardListResponse,
  type BoardSummary,
  type CreateBoardResponse,
  type JoinBoardResponse,
  type LeaveBoardResponse,
  type RenameBoardResponse,
  type RotateJoinCodeResponse,
  type ServiceError,
} from "@tuiscrib/contracts"

export const MAX_OWNED_BOARDS = 20

export type BoardUser = {
  id: number
  username: string
}

export type CreateBoardPersistenceInput = {
  publicId: string
  name: string
  ownerUserId: number
  joinCodeHash: string
  now: Date
}

export type CreateBoardPersistenceResult =
  | { kind: "created"; board: BoardSummary }
  | { kind: "owned_board_limit" }

export type RenameBoardPersistenceInput = {
  userId: number
  publicId: string
  name: string
}

export type RenameBoardPersistenceResult =
  | { kind: "renamed"; board: BoardSummary }
  | { kind: "not_found" }
  | { kind: "not_owner" }

export type RotateJoinCodePersistenceInput = {
  userId: number
  publicId: string
  joinCodeHash: string
}

export type RotateJoinCodePersistenceResult =
  | { kind: "rotated"; board: BoardSummary }
  | { kind: "not_found" }
  | { kind: "not_owner" }

export type ListBoardsPersistenceInput = {
  userId: number
  nameFilter: string
}

export type BoardPersistence = {
  createBoard(input: CreateBoardPersistenceInput): Promise<CreateBoardPersistenceResult>
  renameBoard?(input: RenameBoardPersistenceInput): Promise<RenameBoardPersistenceResult>
  rotateJoinCode?(input: RotateJoinCodePersistenceInput): Promise<RotateJoinCodePersistenceResult>
  joinBoard?(input: JoinBoardPersistenceInput): Promise<JoinBoardPersistenceResult>
  leaveBoard?(input: LeaveBoardPersistenceInput): Promise<LeaveBoardPersistenceResult>
  listBoards(input: ListBoardsPersistenceInput): Promise<BoardSummary[]>
}

export type JoinBoardPersistenceInput = {
  userId: number
  joinCodeHash: string
  now: Date
}

export type JoinBoardPersistenceResult =
  | { kind: "joined"; board: BoardSummary }
  | { kind: "invalid_join_code" }
  | { kind: "already_member" }
  | { kind: "board_capacity" }

export type LeaveBoardPersistenceInput = {
  userId: number
  publicId: string
  now: Date
}

export type LeaveBoardPersistenceResult =
  | { kind: "left" }
  | { kind: "not_member" }
  | { kind: "owner_cannot_leave" }

export type BoardRateLimitOptions = {
  maxAttempts?: number
  windowMs?: number
  now?: () => number
}

type BoardRateLimitBucket = {
  startedAt: number
  attempts: number
}

export class BoardJoinRateLimiter {
  private readonly maxAttempts: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly buckets = new Map<string, BoardRateLimitBucket>()

  constructor(options: BoardRateLimitOptions = {}) {
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5))
    this.windowMs = Math.max(1, Math.floor(options.windowMs ?? 60_000))
    this.now = options.now ?? (() => Date.now())
  }

  consume(keys: string[]): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const uniqueKeys = [...new Set(keys.filter((key) => key.length > 0))]
    const now = this.now()
    let retryAfterMs = 0

    for (const key of uniqueKeys) {
      const bucket = this.currentBucket(key, now)
      if (bucket.attempts >= this.maxAttempts) {
        retryAfterMs = Math.max(retryAfterMs, this.windowMs - (now - bucket.startedAt))
      }
    }

    if (retryAfterMs > 0) {
      return { allowed: false, retryAfterMs }
    }

    for (const key of uniqueKeys) {
      this.currentBucket(key, now).attempts += 1
    }

    return { allowed: true }
  }

  private currentBucket(key: string, now: number): BoardRateLimitBucket {
    const existing = this.buckets.get(key)
    if (existing && now - existing.startedAt < this.windowMs) {
      return existing
    }

    const bucket = { startedAt: now, attempts: 0 }
    this.buckets.set(key, bucket)
    return bucket
  }
}

export type BoardAdministrationOptions = {
  persistence: BoardPersistence
  clock?: () => Date
  boardIdGenerator?: () => string
  joinCodeGenerator?: () => string
  rateLimiter?: BoardJoinRateLimiter
  rateLimit?: BoardRateLimitOptions
}

export type BoardCreateOperationResult =
  | { kind: "success"; response: CreateBoardResponse }
  | { kind: "failure"; status: 400 | 409 | 503; error: ServiceError }

export type BoardListOperationResult =
  | { kind: "success"; response: BoardListResponse }
  | { kind: "failure"; status: 400 | 503; error: ServiceError }

export type BoardJoinOperationResult =
  | { kind: "success"; response: JoinBoardResponse }
  | { kind: "failure"; status: 400 | 404 | 409 | 429 | 503; error: ServiceError }

export type BoardRenameOperationResult =
  | { kind: "success"; response: RenameBoardResponse }
  | { kind: "failure"; status: 400 | 403 | 404 | 503; error: ServiceError }

export type BoardRotateJoinCodeOperationResult =
  | { kind: "success"; response: RotateJoinCodeResponse }
  | { kind: "failure"; status: 403 | 404 | 503; error: ServiceError }

export type BoardLeaveOperationResult =
  | { kind: "success"; response: LeaveBoardResponse }
  | { kind: "failure"; status: 404 | 409 | 503; error: ServiceError }

const defaultBoardIdGenerator = () => randomBytes(16).toString("base64url")

export function createJoinCode(): string {
  const bytes = randomBytes(16)
  let buffer = 0
  let availableBits = 0
  let code = ""

  for (const byte of bytes) {
    buffer = buffer * 256 + byte
    availableBits += 8
    while (availableBits >= 5 && code.length < JOIN_CODE_UNGROUPED_LENGTH) {
      availableBits -= 5
      const index = Math.floor(buffer / 2 ** availableBits) % JOIN_CODE_ALPHABET.length
      code += JOIN_CODE_ALPHABET[index]
      buffer %= 2 ** availableBits
    }
  }

  if (code.length < JOIN_CODE_UNGROUPED_LENGTH && availableBits > 0) {
    const index = (buffer * 2 ** (5 - availableBits)) % JOIN_CODE_ALPHABET.length
    code += JOIN_CODE_ALPHABET[index]
  }

  return code
}

export function normalizeJoinCode(joinCode: string): string {
  return joinCode.replaceAll("-", "").toUpperCase()
}

export function formatJoinCode(joinCode: string): string {
  const normalized = normalizeJoinCode(joinCode)
  const groups: string[] = []
  for (let index = 0; index < normalized.length; index += 4) {
    groups.push(normalized.slice(index, index + 4))
  }
  return groups.join("-")
}

export function hashJoinCode(joinCode: string): string {
  return createHash("sha256").update(normalizeJoinCode(joinCode), "utf8").digest("hex")
}

export function createBoardAdministration(options: BoardAdministrationOptions) {
  const clock = options.clock ?? (() => new Date())
  const boardIdGenerator = options.boardIdGenerator ?? defaultBoardIdGenerator
  const joinCodeGenerator = options.joinCodeGenerator ?? createJoinCode
  const rateLimiter =
    options.rateLimiter ??
    new BoardJoinRateLimiter({
      ...options.rateLimit,
      now: options.rateLimit?.now ?? (() => clock().getTime()),
    })

  return {
    async createBoard(user: BoardUser, input: unknown): Promise<BoardCreateOperationResult> {
      const parsed = createBoardRequestSchema.safeParse(input)
      if (!parsed.success) {
        return invalidBoardInput(parsed.error)
      }

      const joinCode = joinCodeGenerator()
      const formattedJoinCode = formatJoinCode(joinCode)
      if (!joinCodeSchema.safeParse(formattedJoinCode).success) {
        throw new Error("join code generator returned an invalid Join Code")
      }

      const result = await options.persistence.createBoard({
        publicId: boardIdGenerator(),
        name: parsed.data.name,
        ownerUserId: user.id,
        joinCodeHash: hashJoinCode(joinCode),
        now: clock(),
      })

      if (result.kind === "owned_board_limit") {
        return {
          kind: "failure",
          status: 409,
          error: serviceErrorSchema.parse({
            error: `A User may own at most ${MAX_OWNED_BOARDS} Boards.`,
            code: "owned_board_limit",
          }),
        }
      }

      return {
        kind: "success",
        response: createBoardResponseSchema.parse({
          board: result.board,
          joinCode: formattedJoinCode,
        }),
      }
    },

    async renameBoard(
      user: BoardUser,
      publicId: string,
      input: unknown,
    ): Promise<BoardRenameOperationResult> {
      if (!options.persistence.renameBoard) {
        return unavailableRename()
      }
      if (!boardIdentifierSchema.safeParse(publicId).success) {
        return boardNotFoundRename()
      }

      const parsed = renameBoardRequestSchema.safeParse(input)
      if (!parsed.success) {
        return invalidRenameInput(parsed.error)
      }

      const result = await options.persistence.renameBoard({
        userId: user.id,
        publicId,
        name: parsed.data.name,
      })

      switch (result.kind) {
        case "renamed":
          return {
            kind: "success",
            response: renameBoardResponseSchema.parse({ board: result.board }),
          }
        case "not_owner":
          return ownerRequiredRename()
        case "not_found":
          return boardNotFoundRename()
      }
    },

    async rotateJoinCode(
      user: BoardUser,
      publicId: string,
    ): Promise<BoardRotateJoinCodeOperationResult> {
      if (!options.persistence.rotateJoinCode) {
        return unavailableRotateJoinCode()
      }
      if (!boardIdentifierSchema.safeParse(publicId).success) {
        return boardNotFoundRotateJoinCode()
      }

      const joinCode = joinCodeGenerator()
      const formattedJoinCode = formatJoinCode(joinCode)
      if (!joinCodeSchema.safeParse(formattedJoinCode).success) {
        throw new Error("join code generator returned an invalid Join Code")
      }

      const result = await options.persistence.rotateJoinCode({
        userId: user.id,
        publicId,
        joinCodeHash: hashJoinCode(joinCode),
      })

      switch (result.kind) {
        case "rotated":
          return {
            kind: "success",
            response: rotateJoinCodeResponseSchema.parse({
              board: result.board,
              joinCode: formattedJoinCode,
            }),
          }
        case "not_owner":
          return ownerRequiredRotateJoinCode()
        case "not_found":
          return boardNotFoundRotateJoinCode()
      }
    },

    async joinBoard(
      user: BoardUser,
      input: unknown,
      signals: { networkKey: string },
    ): Promise<BoardJoinOperationResult> {
      const rateLimitResult = rateLimiter.consume([
        `network:${signals.networkKey || "unknown"}`,
        `user:${user.id}`,
        ...joinCodeRateLimitKey(input),
      ])
      if (!rateLimitResult.allowed) {
        return rateLimitedJoin(rateLimitResult.retryAfterMs)
      }

      const parsed = joinBoardRequestSchema.safeParse(input)
      if (!parsed.success) {
        return invalidJoinInput(parsed.error)
      }
      if (!options.persistence.joinBoard) {
        return unavailableJoin()
      }

      const result = await options.persistence.joinBoard({
        userId: user.id,
        joinCodeHash: hashJoinCode(parsed.data.joinCode),
        now: clock(),
      })

      switch (result.kind) {
        case "joined":
          return {
            kind: "success",
            response: joinBoardResponseSchema.parse({ board: result.board }),
          }
        case "invalid_join_code":
          return {
            kind: "failure",
            status: 404,
            error: serviceErrorSchema.parse({
              error: "That Join Code is invalid.",
              code: "invalid_join_code",
            }),
          }
        case "already_member":
          return {
            kind: "failure",
            status: 409,
            error: serviceErrorSchema.parse({
              error: "You are already a Member of this Board.",
              code: "already_member",
            }),
          }
        case "board_capacity":
          return {
            kind: "failure",
            status: 409,
            error: serviceErrorSchema.parse({
              error: `This Board cannot accept more than ${MAX_BOARD_MEMBERS} Memberships.`,
              code: "board_capacity",
            }),
          }
      }
    },

    async leaveBoard(user: BoardUser, publicId: string): Promise<BoardLeaveOperationResult> {
      if (!options.persistence.leaveBoard) {
        return unavailableLeave()
      }
      if (!boardIdentifierSchema.safeParse(publicId).success) {
        return notMember()
      }

      const result = await options.persistence.leaveBoard({
        userId: user.id,
        publicId,
        now: clock(),
      })

      return result.kind === "left"
        ? { kind: "success", response: leaveBoardResponseSchema.parse({ status: "left" }) }
        : result.kind === "owner_cannot_leave"
          ? {
              kind: "failure",
              status: 409,
              error: serviceErrorSchema.parse({
                error: "The Owner cannot leave this Board.",
                code: "owner_cannot_leave",
              }),
            }
          : notMember()
    },

    async listBoards(user: BoardUser, nameFilter: string): Promise<BoardListOperationResult> {
      const boards = await options.persistence.listBoards({
        userId: user.id,
        nameFilter: nameFilter.trim(),
      })
      return {
        kind: "success",
        response: boardListResponseSchema.parse({ boards }),
      }
    },
  }
}

function joinCodeRateLimitKey(input: unknown): string[] {
  if (!input || typeof input !== "object" || !("joinCode" in input)) {
    return []
  }
  const joinCode = (input as { joinCode?: unknown }).joinCode
  if (typeof joinCode !== "string" || joinCode.length === 0) {
    return []
  }
  return [`join-code:${hashJoinCode(joinCode.slice(0, 128))}`]
}

function invalidJoinInput(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>
}): BoardJoinOperationResult {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form")
    fieldErrors[field] ??= issue.message
  }

  return {
    kind: "failure",
    status: 400,
    error: serviceErrorSchema.parse({
      error: "Check the highlighted fields.",
      code: "invalid_input",
      fieldErrors,
    }),
  }
}

function rateLimitedJoin(retryAfterMs: number): BoardJoinOperationResult {
  return {
    kind: "failure",
    status: 429,
    error: serviceErrorSchema.parse({
      error: "Too many Join Code attempts. Try again later.",
      code: "rate_limited",
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    }),
  }
}

function unavailableJoin(): BoardJoinOperationResult {
  return {
    kind: "failure",
    status: 503,
    error: serviceErrorSchema.parse({ error: "service unavailable" }),
  }
}

function unavailableLeave(): BoardLeaveOperationResult {
  return {
    kind: "failure",
    status: 503,
    error: serviceErrorSchema.parse({ error: "service unavailable" }),
  }
}

function invalidRenameInput(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>
}): BoardRenameOperationResult {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form")
    fieldErrors[field] ??= issue.message
  }

  return {
    kind: "failure",
    status: 400,
    error: serviceErrorSchema.parse({
      error: "Check the highlighted fields.",
      code: "invalid_input",
      fieldErrors,
    }),
  }
}

function unavailableRename(): BoardRenameOperationResult {
  return {
    kind: "failure",
    status: 503,
    error: serviceErrorSchema.parse({ error: "service unavailable" }),
  }
}

function ownerRequiredRename(): BoardRenameOperationResult {
  return {
    kind: "failure",
    status: 403,
    error: serviceErrorSchema.parse({
      error: "Only the Owner may rename this Board.",
      code: "owner_required",
    }),
  }
}

function boardNotFoundRename(): BoardRenameOperationResult {
  return {
    kind: "failure",
    status: 404,
    error: serviceErrorSchema.parse({
      error: "Board was not found.",
      code: "board_not_found",
    }),
  }
}

function unavailableRotateJoinCode(): BoardRotateJoinCodeOperationResult {
  return {
    kind: "failure",
    status: 503,
    error: serviceErrorSchema.parse({ error: "service unavailable" }),
  }
}

function ownerRequiredRotateJoinCode(): BoardRotateJoinCodeOperationResult {
  return {
    kind: "failure",
    status: 403,
    error: serviceErrorSchema.parse({
      error: "Only the Owner may rotate this Join Code.",
      code: "owner_required",
    }),
  }
}

function boardNotFoundRotateJoinCode(): BoardRotateJoinCodeOperationResult {
  return {
    kind: "failure",
    status: 404,
    error: serviceErrorSchema.parse({
      error: "Board was not found.",
      code: "board_not_found",
    }),
  }
}

function notMember(): BoardLeaveOperationResult {
  return {
    kind: "failure",
    status: 404,
    error: serviceErrorSchema.parse({
      error: "Board Membership was not found.",
      code: "membership_not_found",
    }),
  }
}
function invalidBoardInput(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>
}): BoardCreateOperationResult {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form")
    fieldErrors[field] ??= issue.message
  }

  return {
    kind: "failure",
    status: 400,
    error: serviceErrorSchema.parse({
      error: "Check the highlighted fields.",
      code: "invalid_input",
      fieldErrors,
    }),
  }
}
