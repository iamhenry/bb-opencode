import { describe, expect, it } from "vitest";
import {
  assistantsAfterLastUser,
  filterMessagesByRevertPoint,
  hydrateDeltas,
  lastUserAgent,
  lastUserMessageId,
  retainThroughMessageId,
  revertMessageIdOf,
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
    expect(deltas).toEqual(
      expect.arrayContaining([
        { kind: "turn.open" },
        { kind: "input.provider", text: "hi" },
      ]),
    );
    expect(
      deltas.filter((delta) => delta.kind === "input.provider"),
    ).toHaveLength(1);
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
    expect(
      retainThroughMessageId([
        { info: { id: "u1", role: "user" }, parts: [] },
        { info: { id: "a1", role: "assistant" }, parts: [] },
      ]),
    ).toBe("a1");
    const twoTurns = hydrateDeltas({
      sessionId: "s",
      messages: [
        { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "one" }] },
        { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
        { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "two" }] },
        { info: { id: "a2", role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
      ],
    }).filter(
      (delta) =>
        delta.kind === "turn.boundary" && delta.status === "completed",
    );
    expect(twoTurns.map((delta) => delta.providerCheckpointId)).toEqual([
      "a1",
      "a2",
    ]);
    expect(lastUserAgent([
      { info: { role: "user", agent: "plan" }, parts: [] },
      { info: { role: "assistant" }, parts: [] },
    ])).toBe("plan");
  });

  it("hides the revert cursor and everything after it, like OpenChamber",
    () => {
      expect(revertMessageIdOf({ revert: { messageID: "u1" } })).toBe("u1");
      expect(
        filterMessagesByRevertPoint(
          [
            { info: { id: "u1", role: "user" }, parts: [] },
            { info: { id: "a1", role: "assistant" }, parts: [] },
          ],
          "u1",
        ).map((message) => message.info.id),
      ).toEqual([]);
    },
  );
});
