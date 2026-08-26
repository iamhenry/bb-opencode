import { describe, expect, it } from "vitest";
import {
  buildOpenCodeRevertState,
  EMPTY_REVERT_STATE,
} from "../src/revert-state.js";

const messages = [
  {
    info: { id: "u1", role: "user" },
    parts: [{ type: "text", text: "first" }],
  },
  {
    info: { id: "a1", role: "assistant" },
    parts: [{ type: "text", text: "answer" }],
  },
  {
    info: { id: "u2", role: "user" },
    parts: [
      { type: "text", text: "second" },
      { type: "text", text: "generated", synthetic: true },
      { type: "file", filename: "photo.png" },
      { type: "file", filename: "generated.txt", synthetic: true },
    ],
  },
  {
    info: { id: "a2", role: "assistant" },
    parts: [{ type: "text", text: "later answer" }],
  },
  {
    info: { id: "u3", role: "user" },
    parts: [{ type: "text", text: "third" }],
  },
];

describe("OpenCode revert state", () => {
  it("restores the selected user text and retains reverted user previews", () => {
    expect(
      buildOpenCodeRevertState({
        revertMessageID: "u2",
        messages,
      }),
    ).toEqual({
      active: true,
      messageID: "u2",
      promptText: "second",
      messages: [
        { id: "u2", text: "second", attachments: ["photo.png"] },
        { id: "u3", text: "third", attachments: [] },
      ],
    });
  });

  it("is inactive without an authoritative marker in the message list", () => {
    expect(buildOpenCodeRevertState({ messages })).toBe(EMPTY_REVERT_STATE);
    expect(
      buildOpenCodeRevertState({
        revertMessageID: "missing",
        messages,
      }),
    ).toBe(EMPTY_REVERT_STATE);
  });
});
