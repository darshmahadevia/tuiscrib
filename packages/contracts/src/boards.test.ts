import { expect, test } from "bun:test"

import {
  boardListResponseSchema,
  boardNameSchema,
  createBoardRequestSchema,
  createBoardResponseSchema,
  deleteBoardResponseSchema,
  joinBoardRequestSchema,
  joinBoardResponseSchema,
  joinCodeSchema,
  leaveBoardResponseSchema,
  renameBoardRequestSchema,
  renameBoardResponseSchema,
  rotateJoinCodeResponseSchema,
} from "./boards.ts"

test("Board names trim surrounding whitespace and count user-perceived characters", () => {
  expect(boardNameSchema.parse("  Café  ")).toBe("Café")
  expect(boardNameSchema.parse("😀".repeat(80))).toBe("😀".repeat(80))
})

test("Board names reject empty, multiline, and overlong values", () => {
  expect(() => boardNameSchema.parse("   ")).toThrow()
  expect(() => boardNameSchema.parse("one\ntwo")).toThrow()
  expect(() => boardNameSchema.parse("😀".repeat(81))).toThrow()
})

test("Board contracts accept grouped case-insensitive human-safe Join Codes", () => {
  const joinCode = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-45"
  expect(joinCodeSchema.parse(joinCode)).toBe(joinCode)
  expect(() => joinCodeSchema.parse("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ")).toThrow()
})

test("Board creation and listing contracts distinguish Ownership from Membership", () => {
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Ideas",
    role: "owner" as const,
  }

  expect(createBoardRequestSchema.parse({ name: " Ideas " })).toEqual({ name: "Ideas" })
  expect(
    createBoardResponseSchema.parse({
      board,
      joinCode: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-45",
    }),
  ).toEqual({
    board,
    joinCode: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-45",
  })
  expect(
    boardListResponseSchema.parse({
      boards: [board, { ...board, id: "wB4aY9vT5sR2pM8nK3u7xQ", role: "member" }],
    }).boards.map(({ name, role }) => ({ name, role })),
  ).toEqual([
    { name: "Ideas", role: "owner" },
    { name: "Ideas", role: "member" },
  ])
})

test("Join and leave contracts carry Membership state without returning a Join Code", () => {
  const board = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Ideas",
    role: "member" as const,
  }

  expect(joinBoardRequestSchema.parse({
    joinCode: "abcd-efgh-jkmn-pqrs-tvwx-yz23-45",
  })).toEqual({ joinCode: "abcd-efgh-jkmn-pqrs-tvwx-yz23-45" })
  expect(joinBoardResponseSchema.parse({ board })).toEqual({ board })
  expect(leaveBoardResponseSchema.parse({ status: "left" })).toEqual({ status: "left" })
  expect(joinBoardResponseSchema.parse({ board, joinCode: "secret" })).toEqual({ board })
})

test("Owner governance contracts validate Board rename and one-time Join Code rotation", () => {
  const ownerBoard = {
    id: "Qx7u3nW8kM2pR5sT9vY4aB",
    name: "Renamed Ideas",
    role: "owner" as const,
  }
  const joinCode = "WXYZ-2345-6789-ABCD-EFGH-JKMN-PQ"

  expect(renameBoardRequestSchema.parse({ name: " Renamed Ideas " })).toEqual({
    name: "Renamed Ideas",
  })
  expect(renameBoardResponseSchema.parse({ board: ownerBoard })).toEqual({
    board: ownerBoard,
  })
  expect(rotateJoinCodeResponseSchema.parse({ board: ownerBoard, joinCode })).toEqual({
    board: ownerBoard,
    joinCode,
  })
})

test("Board deletion returns only an explicit durable-deletion status", () => {
  expect(deleteBoardResponseSchema.parse({ status: "deleted" })).toEqual({
    status: "deleted",
  })
  expect(() => deleteBoardResponseSchema.parse({ status: "deleted", board: "Ideas" })).toThrow()
})
