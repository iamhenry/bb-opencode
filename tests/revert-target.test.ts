import { describe, expect, it } from "vitest";
import {
  resolveRevertCheckpointId,
  resolveRevertMessageId,
} from "../src/revert-target.js";

const messages = [
  {
    info: { id: "u1", role: "user" },
    parts: [{ type: "text", text: "same prompt" }],
  },
  {
    info: { id: "a1", role: "assistant" },
    parts: [{ type: "text", text: "reply one" }],
  },
  {
    info: { id: "u2", role: "user" },
    parts: [{ type: "text", text: "same prompt" }],
  },
];

describe("resolveRevertMessageId", () => {
  it("passes through an explicit user message ID", () => {
    expect(resolveRevertMessageId({ messages, messageID: "u2" })).toBe("u2");
  });

  it("normalizes an explicit assistant message ID to its owning user", () => {
    expect(resolveRevertMessageId({ messages, messageID: "a1" })).toBe("u1");
  });

  it("rejects an explicit ID not present in the loaded history", () => {
    expect(resolveRevertMessageId({ messages, messageID: "provider-id" })).toBeUndefined();
  });

  it("rejects duplicated IDs and IDs for non-user, non-assistant messages", () => {
    expect(
      resolveRevertMessageId({
        messages: [...messages, { info: { id: "u2", role: "user" } }],
        messageID: "u2",
      }),
    ).toBeUndefined();
    expect(
      resolveRevertMessageId({
        messages: [{ info: { id: "tool-1", role: "tool" } }],
        messageID: "tool-1",
      }),
    ).toBeUndefined();
  });

  it("refuses an assistant ID without an earlier user message", () => {
    expect(
      resolveRevertMessageId({
        messages: [messages[1]!],
        messageID: "a1",
      }),
    ).toBeUndefined();
  });

  it("never guesses from text, role, or a single candidate", () => {
    expect(
      resolveRevertMessageId({
        messages: [messages[0]!],
        role: "user",
        text: "same prompt",
      }),
    ).toBeUndefined();
    expect(
      resolveRevertMessageId({
        messages,
        role: "user",
        text: "same prompt",
      }),
    ).toBeUndefined();
  });
});

describe("resolveRevertCheckpointId", () => {
  const rows = [
    {
      id: "turn-row",
      kind: "turn",
      children: [
        {
          id: "bb-user-row",
          kind: "conversation",
          role: "user",
          turnId: "turn-1",
        },
        {
          id: "bb-assistant-row",
          kind: "conversation",
          role: "assistant",
          turnId: "turn-1",
        },
      ],
    },
  ];

  it("maps either conversation row to that turn's user checkpoint", () => {
    const boundaries = [
      {
        type: "turn/completed",
        scope: { kind: "turn", turnId: "other-turn" },
        data: { providerCheckpointId: "wrong-user-id" },
      },
      {
        type: "turn/completed",
        scope: { kind: "turn", turnId: "turn-1" },
        data: { providerCheckpointId: "opencode-user-id" },
      },
    ];
    expect(
      resolveRevertCheckpointId({ rows, messageId: "bb-user-row", boundaries }),
    ).toBe("opencode-user-id");
    expect(
      resolveRevertCheckpointId({ rows, messageId: "bb-assistant-row", boundaries }),
    ).toBe("opencode-user-id");
  });

  it("maps a thread's opening prompt (no turnId) to the turn that follows it", () => {
    const opening = [
      { id: "seed-user", kind: "conversation", role: "user", turnId: null },
      { id: "turn-row", kind: "turn", turnId: "turn-1" },
      { id: "next-user", kind: "conversation", role: "user", turnId: null },
      { id: "turn-row-2", kind: "turn", turnId: "turn-2" },
    ];
    const boundaries = [
      {
        type: "turn/completed",
        scope: { kind: "turn", turnId: "turn-1" },
        data: { providerCheckpointId: "opening-prompt-id" },
      },
    ];
    expect(
      resolveRevertCheckpointId({ rows: opening, messageId: "seed-user", boundaries }),
    ).toBe("opening-prompt-id");
    expect(
      resolveRevertCheckpointId({ rows: opening.slice(0, 1), messageId: "seed-user", boundaries }),
    ).toBeUndefined();
  });

  it("fails closed for missing or ambiguous turn checkpoints", () => {
    expect(
      resolveRevertCheckpointId({ rows, messageId: "bb-user-row", boundaries: [] }),
    ).toBeUndefined();
    expect(
      resolveRevertCheckpointId({
        rows,
        messageId: "bb-user-row",
        boundaries: [
          {
            type: "turn/completed",
            scope: { kind: "turn", turnId: "turn-1" },
          },
          {
            type: "turn/completed",
            scope: { kind: "turn", turnId: "turn-1" },
            data: { providerCheckpointId: "ambiguous" },
          },
        ],
      }),
    ).toBeUndefined();
  });
});
