import { describe, expect, it } from "vitest";
import { resolveRevertMessageId } from "../src/revert-target.js";

const messages = [
  {
    info: { id: "u1", role: "user" },
    parts: [{ type: "text", text: "first" }],
  },
  {
    info: { id: "a1", role: "assistant" },
    parts: [{ type: "text", text: "reply one" }],
  },
  {
    info: { id: "u2", role: "user" },
    parts: [{ type: "text", text: "echo ISC63_SHOULD_NOT_RUN" }],
  },
  {
    info: { id: "a2", role: "assistant" },
    parts: [{ type: "text", text: "denied" }],
  },
];

describe("resolveRevertMessageId", () => {
  it("uses an explicit OpenCode messageID", () => {
    expect(
      resolveRevertMessageId({ messages, messageID: "a1" }),
    ).toBe("a1");
  });

  it("matches a user bubble by text", () => {
    expect(
      resolveRevertMessageId({
        messages,
        role: "user",
        text: "echo ISC63_SHOULD_NOT_RUN",
      }),
    ).toBe("u2");
  });

  it("matches an assistant bubble by text", () => {
    expect(
      resolveRevertMessageId({
        messages,
        role: "assistant",
        text: "reply one",
      }),
    ).toBe("a1");
  });

  it("matches the visible user prompt after BB project instructions", () => {
    expect(
      resolveRevertMessageId({
        messages: [
          {
            info: { id: "u-theme", role: "user" },
            parts: [
              { type: "text", text: "[BB project instructions]\nYou are working inside bb" },
              {
                type: "text",
                text: "create a bb theme for both light and dark theme",
              },
            ],
          },
        ],
        role: "user",
        text: "create a bb theme for both light and dark theme",
      }),
    ).toBe("u-theme");
  });

  it("refuses when the clicked text matches nothing uniquely", () => {
    expect(
      resolveRevertMessageId({
        messages,
        role: "user",
        text: "no such bubble",
      }),
    ).toBeUndefined();
  });

  it("refuses duplicate identical texts instead of guessing", () => {
    expect(
      resolveRevertMessageId({
        messages: [
          ...messages,
          {
            info: { id: "u3", role: "user" },
            parts: [{ type: "text", text: "first" }],
          },
        ],
        role: "user",
        text: "first",
      }),
    ).toBeUndefined();
  });
});
