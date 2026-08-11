import { z } from "zod"

import {
  countUserPerceivedCharacters,
  USER_PERCEIVED_CHARACTER_SEGMENTATION_UNAVAILABLE,
} from "./auth.ts"

export const MAX_BOARD_NAME_CHARACTERS = 80
export const MAX_OWNED_BOARDS = 20
export const MAX_BOARD_MEMBERS = 25
export const BOARD_IDENTIFIER_LENGTH = 22
export const JOIN_CODE_UNGROUPED_LENGTH = 26
export const JOIN_CODE_GROUP_LENGTH = 4
export const JOIN_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

const BOARD_IDENTIFIER_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${BOARD_IDENTIFIER_LENGTH}}$`,
)
const JOIN_CODE_PATTERN = new RegExp(
  `^(?:[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_GROUP_LENGTH}}-){6}[${JOIN_CODE_ALPHABET}]{2}$`,
  "i",
)
const SINGLE_LINE_BREAK_PATTERN = /[\r\n\u2028\u2029]/u

export const boardIdentifierSchema = z.string().regex(
  BOARD_IDENTIFIER_PATTERN,
  "Board identifier has an invalid shape.",
)

export const boardNameSchema = z.string().transform((value) => value.trim()).superRefine(
  (value, context) => {
    if (value.length === 0) {
      context.addIssue({ code: "custom", message: "Board name is required." })
      return
    }
    if (SINGLE_LINE_BREAK_PATTERN.test(value)) {
      context.addIssue({ code: "custom", message: "Board name must be a single line." })
    }
    let characterCount: number
    try {
      characterCount = countUserPerceivedCharacters(value)
    } catch {
      context.addIssue({
        code: "custom",
        message: USER_PERCEIVED_CHARACTER_SEGMENTATION_UNAVAILABLE,
      })
      return
    }
    if (characterCount > MAX_BOARD_NAME_CHARACTERS) {
      context.addIssue({
        code: "custom",
        message: `Use at most ${MAX_BOARD_NAME_CHARACTERS} user-perceived characters.`,
      })
    }
  },
)

export const joinCodeSchema = z.string().regex(
  JOIN_CODE_PATTERN,
  "Join Code must use seven groups of a case-insensitive human-safe alphabet.",
)

export const boardRoleSchema = z.enum(["owner", "member"])

export const boardSummarySchema = z.object({
  id: boardIdentifierSchema,
  name: boardNameSchema,
  role: boardRoleSchema,
})

export const createBoardRequestSchema = z.object({
  name: boardNameSchema,
})

export const renameBoardRequestSchema = z.object({
  name: boardNameSchema,
})

export const createBoardResponseSchema = z.object({
  board: boardSummarySchema,
  joinCode: joinCodeSchema,
})

export const renameBoardResponseSchema = z.object({
  board: boardSummarySchema,
})

export const rotateJoinCodeResponseSchema = z.object({
  board: boardSummarySchema,
  joinCode: joinCodeSchema,
})

export const joinBoardRequestSchema = z.object({
  joinCode: joinCodeSchema,
})

export const joinBoardResponseSchema = z.object({
  board: boardSummarySchema,
})

export const leaveBoardResponseSchema = z.object({
  status: z.literal("left"),
})

export const deleteBoardResponseSchema = z.object({
  status: z.literal("deleted"),
}).strict()

export const boardListResponseSchema = z.object({
  boards: z.array(boardSummarySchema),
})

export type BoardRole = z.infer<typeof boardRoleSchema>
export type BoardSummary = z.infer<typeof boardSummarySchema>
export type CreateBoardRequest = z.infer<typeof createBoardRequestSchema>
export type CreateBoardResponse = z.infer<typeof createBoardResponseSchema>
export type RenameBoardRequest = z.infer<typeof renameBoardRequestSchema>
export type RenameBoardResponse = z.infer<typeof renameBoardResponseSchema>
export type RotateJoinCodeResponse = z.infer<typeof rotateJoinCodeResponseSchema>
export type BoardListResponse = z.infer<typeof boardListResponseSchema>
export type JoinBoardRequest = z.infer<typeof joinBoardRequestSchema>
export type JoinBoardResponse = z.infer<typeof joinBoardResponseSchema>
export type LeaveBoardResponse = z.infer<typeof leaveBoardResponseSchema>
export type DeleteBoardResponse = z.infer<typeof deleteBoardResponseSchema>
