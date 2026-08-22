import { describe, expect, it } from "vitest";
import { createMapDeltaState, mapPartDelta } from "../src/map-delta.js";

describe("map-delta", () => {
  it("maps text parts to agent message deltas (ISC-15)", () => {
    const deltas = mapPartDelta({
      state: createMapDeltaState(),
      sessionId: "s",
      part: { id: "t1", type: "text", text: "hello" },
    });
    expect(deltas[0]).toMatchObject({
      kind: "item.textDelta",
      channel: "agentMessage",
      text: "hello",
    });
  });

  it("maps reasoning parts (ISC-16)", () => {
    const deltas = mapPartDelta({
      state: createMapDeltaState(),
      sessionId: "s",
      part: { id: "r1", type: "reasoning", text: "think" },
    });
    expect(deltas[0]).toMatchObject({
      kind: "item.textDelta",
      channel: "reasoningText",
    });
  });

  it("maps tools to generic tool items and bash to command items (ISC-17, ISC-71)", () => {
    const tool = mapPartDelta({
      state: createMapDeltaState(),
      sessionId: "s",
      part: {
        id: "task-1",
        type: "tool",
        tool: "task",
        state: { status: "running", title: "Explore" },
      },
    });
    expect(tool[0]).toMatchObject({
      kind: "item.open",
      item: { type: "tool", tool: "task" },
    });
    const bash = mapPartDelta({
      state: createMapDeltaState(),
      sessionId: "s",
      part: {
        id: "bash-1",
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "ls" } },
      },
    });
    expect(bash[0]).toMatchObject({
      kind: "item.open",
      item: { type: "command", command: "ls" },
    });
  });

  it("keeps successive bash updates on one item id (ISC-18)", () => {
    const state = createMapDeltaState();
    const first = mapPartDelta({
      state,
      sessionId: "s",
      part: {
        id: "bash-1",
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "ls" } },
      },
    });
    const second = mapPartDelta({
      state,
      sessionId: "s",
      part: {
        id: "bash-1",
        type: "tool",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "ls" },
          metadata: { output: "a" },
        },
      },
    });
    expect(first[0]).toMatchObject({ key: { id: "bash-1" } });
    expect(second[0]).toMatchObject({ key: { id: "bash-1" } });
  });
});
