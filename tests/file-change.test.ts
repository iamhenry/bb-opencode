import { describe, expect, it } from "vitest";
import {
  fileChangesFromDiffs,
  fileChangesFromToolInput,
  firstMessageAfterCheckpoint,
  isFileChangeToolName,
  isRewindStagingThread,
} from "../src/file-change.js";

describe("file changes", () => {
  it("maps edit/write args to fileChange rows", () => {
    expect(isFileChangeToolName("edit")).toBe(true);
    expect(
      fileChangesFromToolInput("edit", {
        filePath: "src/a.ts",
        oldString: "a",
        newString: "b",
      }),
    ).toEqual([
      {
        path: "src/a.ts",
        kind: "update",
        oldText: "a",
        newText: "b",
      },
    ]);
    expect(
      fileChangesFromToolInput("write", {
        path: "new.txt",
        content: "hi",
      }),
    ).toEqual([{ path: "new.txt", kind: "add", newText: "hi" }]);
  });

  it("maps OpenCode FileDiff payloads", () => {
    expect(
      fileChangesFromDiffs([
        { file: "gone.md", before: "x", after: "" },
        { file: "added.md", before: "", after: "y" },
      ]),
    ).toEqual([
      { path: "gone.md", kind: "delete", oldText: "x", newText: "" },
      { path: "added.md", kind: "add", oldText: "", newText: "y" },
    ]);
  });

  it("detects BB rewind staging threads and the first dropped message", () => {
    expect(isRewindStagingThread("thr_1:rewind:lease")).toBe(true);
    expect(isRewindStagingThread("thr_1")).toBe(false);
    expect(
      firstMessageAfterCheckpoint(
        [{ info: { id: "keep" } }, { info: { id: "drop" } }],
        "keep",
      ),
    ).toBe("drop");
  });
});
