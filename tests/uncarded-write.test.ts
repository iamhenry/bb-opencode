import { describe, expect, it } from "vitest";
import {
  fileWriteHasPayload,
  nextUncardedWriteStreak,
  runningFileToolName,
  UNCARDED_WRITE_POLLS,
} from "../src/uncarded-write.js";

describe("uncarded write", () => {
  it("ignores apply_patch until it has a patch", () => {
    expect(
      fileWriteHasPayload({
        tool: "apply_patch",
        state: { status: "running" },
      }),
    ).toBe(false);
    expect(
      runningFileToolName([
        {
          parts: [
            {
              tool: "apply_patch",
              state: { status: "running" },
            },
          ],
        },
      ]),
    ).toBeUndefined();
    expect(
      runningFileToolName([
        {
          parts: [
            {
              tool: "apply_patch",
              state: {
                status: "running",
                input: { patchText: "*** Begin Patch\n" },
              },
            },
          ],
        },
      ]),
    ).toBe("apply_patch");
  });

  it("gives up only after a short empty streak", () => {
    let streak = 0;
    for (let i = 0; i < UNCARDED_WRITE_POLLS - 1; i += 1) {
      const next = nextUncardedWriteStreak({
        runningTool: "apply_patch",
        pendingAskCount: 0,
        hasCard: false,
        streak,
      });
      expect(next.giveUp).toBe(false);
      streak = next.streak;
    }
    expect(
      nextUncardedWriteStreak({
        runningTool: "apply_patch",
        pendingAskCount: 0,
        hasCard: false,
        streak,
      }).giveUp,
    ).toBe(true);
  });

  it("resets when an ask or card appears", () => {
    expect(
      nextUncardedWriteStreak({
        runningTool: "edit",
        pendingAskCount: 1,
        hasCard: false,
        streak: 2,
      }),
    ).toEqual({ streak: 0, giveUp: false });
    expect(
      nextUncardedWriteStreak({
        runningTool: "edit",
        pendingAskCount: 0,
        hasCard: true,
        streak: 2,
      }),
    ).toEqual({ streak: 0, giveUp: false });
  });
});
