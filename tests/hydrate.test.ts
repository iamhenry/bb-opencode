import { describe, expect, it } from "vitest";
import { hydrateDeltas, lastUserAgent } from "../src/hydrate.js";

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
    expect(lastUserAgent([
      { info: { role: "user", agent: "plan" }, parts: [] },
      { info: { role: "assistant" }, parts: [] },
    ])).toBe("plan");
  });
});
