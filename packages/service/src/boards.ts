import { createHash, randomBytes } from "node:crypto"

import {
  boardListResponseSchema,
  createBoardRequestSchema,
  createBoardResponseSchema,
  joinCodeSchema,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_UNGROUPED_LENGTH,
  serviceErrorSchema,
  type BoardListResponse,
  type BoardSummary,
  type CreateBoardResponse,
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

export type ListBoardsPersistenceInput = {
  userId: number
  nameFilter: string
}

export type BoardPersistence = {
  createBoard(input: CreateBoardPersistenceInput): Promise<CreateBoardPersistenceResult>
  listBoards(input: ListBoardsPersistenceInput): Promise<BoardSummary[]>
}

export type BoardAdministrationOptions = {
  persistence: BoardPersistence
  clock?: () => Date
  boardIdGenerator?: () => string
  joinCodeGenerator?: () => string
}

export type BoardCreateOperationResult =
  | { kind: "success"; response: CreateBoardResponse }
  | { kind: "failure"; status: 400 | 409; error: ServiceError }

export type BoardListOperationResult =
  | { kind: "success"; response: BoardListResponse }
  | { kind: "failure"; status: 400; error: ServiceError }

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
