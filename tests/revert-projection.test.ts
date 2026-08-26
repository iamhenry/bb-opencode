import { describe, expect, it } from "vitest";
import {
  commitRevertProjection,
  hiddenRevertRowIds,
  rowIdsHiddenByRevert,
  stageRevertProjection,
  undoRevertProjection,
} from "../src/revert-projection.js";

const rows = [
  { id: "u1", kind: "conversation", role: "user" },
  { id: "t1", kind: "turn" },
  { id: "a1", kind: "conversation", role: "assistant" },
  { id: "u2", kind: "conversation", role: "user" },
  { id: "t2", kind: "turn" },
  { id: "a2", kind: "conversation", role: "assistant" },
];

describe("revert timeline projection", () => {
  it("hides from a selected user message through the old suffix", () => {
    expect(rowIdsHiddenByRevert(rows, "u2")).toEqual(["u2", "t2", "a2"]);
  });

  it("normalizes an assistant target to its preceding user turn", () => {
    expect(rowIdsHiddenByRevert(rows, "a2")).toEqual(["u2", "t2", "a2"]);
  });

  it("undoes a staged suffix and commits it only after prompt cleanup", () => {
    const previous = {
      committedRowIds: ["old"],
      stagedRowIds: [],
    };
    const staged = stageRevertProjection(previous, ["u2", "a2"]);
    expect(hiddenRevertRowIds(staged)).toEqual(["old", "u2", "a2"]);
    expect(hiddenRevertRowIds(undoRevertProjection(staged))).toEqual(["old"]);
    expect(hiddenRevertRowIds(commitRevertProjection(staged))).toEqual([
      "old",
      "u2",
      "a2",
    ]);
  });
});
