import { describe, expect, it } from "vitest";
import {
  assistantsAfterLastUser,
  hydrateDeltas,
  lastUserAgent,
  lastUserMessageId,
} from "../src/hydrate.js";

describe("hydrate", () => {
  it("replays a full refetch starting with session.reset (ISC-11)", () => {
    const deltas = hydrateDeltas({
      sessionId: "s",
      messages: [
        {
          info: { role: "user", agent: "plan" },
          parts: [{ id: "u", type: "text", text: "hi" }],
        },
        {
          info: { role: "assistant" },
          parts: [{ id: "a", type: "text", text: "yo" }],
        },
      ],
    });
    expect(deltas[0]).toEqual({ kind: "session.reset" });
    expect(
      assistantsAfterLastUser([
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "hi" }],
        },
        {
          info: { role: "assistant" },
          parts: [{ type: "tool", tool: "read", id: "r1" }],
        },
        {
          info: { role: "assistant" },
          parts: [{ type: "tool", tool: "task", id: "t1" }],
        },
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "done" }],
        },
      ]).map((message) => message.parts[0]?.tool ?? message.parts[0]?.type),
    ).toEqual(["read", "task", "text"]);
    expect(
      lastUserMessageId([
        { info: { id: "u1", role: "user" }, parts: [] },
        { info: { id: "a1", role: "assistant" }, parts: [] },
        { info: { id: "u2", role: "user" }, parts: [] },
      ]),
    ).toBe("u2");
    expect(lastUserAgent([
      { info: { role: "user", agent: "plan" }, parts: [] },
      { info: { role: "assistant" }, parts: [] },
    ])).toBe("plan");
  });
});
