import { describe, expect, it } from "vitest";
import {
  assignRunChips,
  collectChipTargets,
  flattenChipTargetPages,
  formatRunChip,
  messageMetaFromInfo,
  reasoningByTurnFromEvents,
} from "../src/run-chip.js";

describe("formatRunChip", () => {
  it("labels provider/model, reasoning, then agent", () => {
    expect(
      formatRunChip({
        agent: "atlas",
        providerId: "openai",
        modelId: "gpt-5.6-luna",
        reasoning: "high",
      }),
    ).toEqual({
      label: "openai/gpt-5.6-luna · high · atlas",
      title: "openai/gpt-5.6-luna · high · atlas",
    });
  });

  it("omits none reasoning", () => {
    expect(
      formatRunChip({
        agent: "build",
        providerId: "openai",
        modelId: "gpt-5.6-luna",
        reasoning: "none",
      }),
    ).toEqual({
      label: "openai/gpt-5.6-luna · build",
      title: "openai/gpt-5.6-luna · build",
    });
  });

  it("returns null when there is nothing to show", () => {
    expect(formatRunChip({})).toBeNull();
  });
});

describe("messageMetaFromInfo", () => {
  it("reads user model object and assistant provider fields", () => {
    expect(
      messageMetaFromInfo({
        role: "user",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.6-luna" },
      }),
    ).toEqual({
      role: "user",
      agent: "build",
      providerId: "openai",
      modelId: "gpt-5.6-luna",
    });
    expect(
      messageMetaFromInfo({
        role: "assistant",
        mode: "atlas",
        providerID: "openai",
        modelID: "gpt-5.6-luna",
        variant: "medium",
      }),
    ).toEqual({
      role: "assistant",
      agent: "atlas",
      providerId: "openai",
      modelId: "gpt-5.6-luna",
      reasoning: "medium",
    });
  });
});

describe("collectChipTargets", () => {
  it("keeps user and assistant conversation rows and skips system prompts", () => {
    expect(
      collectChipTargets([
        {
          kind: "turn",
          turnId: "t1",
          children: [
            {
              id: "u1",
              kind: "conversation",
              role: "user",
              initiator: "user",
              turnId: "t1",
            },
            {
              id: "sys",
              kind: "conversation",
              role: "user",
              initiator: "system",
              turnId: "t1",
            },
            { id: "cmd", kind: "command", turnId: "t1" },
            {
              id: "a1",
              kind: "conversation",
              role: "assistant",
              turnId: "t1",
            },
          ],
        },
      ]),
    ).toEqual([
      { id: "u1", role: "user", turnId: "t1" },
      { id: "a1", role: "assistant", turnId: "t1" },
    ]);
  });
});

describe("assignRunChips", () => {
  it("pairs OpenCode messages onto BB rows", () => {
    const rows = assignRunChips({
      targets: [
        { id: "u1", role: "user", turnId: "t1" },
        { id: "a1", role: "assistant", turnId: "t1" },
      ],
      messages: [
        {
          role: "user",
          agent: "atlas",
          providerId: "openai",
          modelId: "gpt-5.6-luna",
        },
        {
          role: "assistant",
          agent: "atlas",
          providerId: "openai",
          modelId: "gpt-5.6-luna",
        },
      ],
      reasoningByTurn: new Map([["t1", "high"]]),
    });
    expect(rows).toEqual([
      {
        id: "u1",
        label: "openai/gpt-5.6-luna · high · atlas",
        title: "openai/gpt-5.6-luna · high · atlas",
      },
      {
        id: "a1",
        label: "openai/gpt-5.6-luna · high · atlas",
        title: "openai/gpt-5.6-luna · high · atlas",
      },
    ]);
  });

  it("keeps only the last assistant bubble in the thread", () => {
    const rows = assignRunChips({
      targets: [
        { id: "u1", role: "user", turnId: "t1" },
        { id: "a1", role: "assistant", turnId: "t1" },
        { id: "a2", role: "assistant", turnId: "t2" },
      ],
      messages: [
        {
          role: "user",
          agent: "build",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
        },
        {
          role: "assistant",
          agent: "build",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          reasoning: "medium",
        },
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["u1", "a2"]);
    expect(rows[1]?.label).toBe("openai/gpt-5.6-sol · medium · build");
  });

  it("aligns a BB timeline suffix with the latest OpenCode turns", () => {
    const rows = assignRunChips({
      targets: [
        { id: "u-new", role: "user", turnId: "t2" },
        { id: "a-new", role: "assistant", turnId: "t2" },
      ],
      messages: [
        {
          role: "user",
          agent: "build",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
        },
        {
          role: "assistant",
          agent: "build",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          reasoning: "medium",
        },
        {
          role: "user",
          agent: "build",
          providerId: "xai",
          modelId: "grok-4.6",
        },
        {
          role: "assistant",
          agent: "build",
          providerId: "xai",
          modelId: "grok-4.6",
        },
      ],
      reasoningByTurn: new Map([["t2", "medium"]]),
    });
    expect(rows).toEqual([
      {
        id: "u-new",
        label: "xai/grok-4.6 · medium · build",
        title: "xai/grok-4.6 · medium · build",
      },
      {
        id: "a-new",
        label: "xai/grok-4.6 · medium · build",
        title: "xai/grok-4.6 · medium · build",
      },
    ]);
  });
});

describe("reasoningByTurnFromEvents", () => {
  it("reads client/turn/requested execution", () => {
    const byTurn = reasoningByTurnFromEvents([
      {
        type: "client/turn/requested",
        turnId: "t1",
        payload: { execution: { reasoningLevel: "medium" } },
      },
    ]);
    expect(byTurn.get("t1")).toBe("medium");
  });
});

describe("flattenChipTargetPages", () => {
  it("puts older timeline pages before newer ones", () => {
    expect(
      flattenChipTargetPages([
        [{ id: "new-user", role: "user" }],
        [{ id: "old-user", role: "user" }],
      ]).map((row) => row.id),
    ).toEqual(["old-user", "new-user"]);
  });
});
