import { describe, expect, it } from "vitest";
import {
  assistantTokenUsage,
  modelContextLimit,
  rememberModelWindows,
  usageDeltasFromMessages,
} from "../src/usage.js";

describe("usage", () => {
  it("reads OpenCode limit.context as the window size", () => {
    expect(modelContextLimit({ limit: { context: 200_000 } })).toBe(200_000);
    expect(modelContextLimit({})).toBeNull();
  });

  it("maps assistant tokens into last usage and context used", () => {
    expect(
      assistantTokenUsage({
        role: "assistant",
        providerID: "opencode",
        modelID: "big-pickle",
        tokens: {
          input: 1200,
          output: 80,
          reasoning: 20,
          cache: { read: 8000, write: 100 },
        },
      }),
    ).toEqual({
      last: {
        totalTokens: 9400,
        inputTokens: 1200,
        cachedInputTokens: 8100,
        outputTokens: 80,
        reasoningOutputTokens: 20,
      },
      used: 9200,
      modelId: "opencode/big-pickle",
    });
  });

  it("emits usage + contextWindow for the native BB meter", () => {
    const windows = new Map<string, number>();
    rememberModelWindows(windows, [
      {
        id: "opencode",
        models: { "big-pickle": { limit: { context: 200_000 } } },
      },
    ]);
    const deltas = usageDeltasFromMessages(
      [
        { info: { role: "user" } },
        {
          info: {
            role: "assistant",
            providerID: "opencode",
            modelID: "big-pickle",
            tokens: {
              input: 100,
              output: 10,
              reasoning: 0,
              cache: { read: 900, write: 0 },
            },
          },
        },
      ],
      windows,
    );
    expect(deltas).toEqual([
      {
        kind: "usage",
        last: {
          totalTokens: 1010,
          inputTokens: 100,
          cachedInputTokens: 900,
          outputTokens: 10,
          reasoningOutputTokens: 0,
        },
        total: {
          totalTokens: 1010,
          inputTokens: 100,
          cachedInputTokens: 900,
          outputTokens: 10,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 200_000,
      },
      {
        kind: "contextWindow",
        used: 1000,
        size: 200_000,
        estimated: true,
        attach: "currentOrLast",
      },
    ]);
  });
});
