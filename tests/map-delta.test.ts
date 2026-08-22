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
      item: { type: "delegation", label: "Explore" },
    });
    const read = mapPartDelta({
      state: createMapDeltaState(),
      sessionId: "s",
      part: {
        id: "read-1",
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "package.json" } },
      },
    });
    expect(read[0]).toMatchObject({
      kind: "item.open",
      item: { type: "fileRead", path: "package.json" },
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

  it("emits only new text suffix so turns stream instead of dumping", () => {
    const state = createMapDeltaState();
    const first = mapPartDelta({
      state,
      sessionId: "s",
      part: { id: "t1", type: "text", text: "Hel" },
    });
    const second = mapPartDelta({
      state,
      sessionId: "s",
      part: { id: "t1", type: "text", text: "Hello" },
      delta: "lo",
    });
    expect(first[0]).toMatchObject({ text: "Hel" });
    expect(second[0]).toMatchObject({ text: "lo" });
    expect(
      mapPartDelta({
        state,
        sessionId: "s",
        part: { id: "t1", type: "text", text: "Hello" },
      }),
    ).toEqual([]);
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
    expect(first[0]).toMatchObject({ key: { providerItemId: "bash-1" } });
    expect(second[0]).toMatchObject({ key: { providerItemId: "bash-1" } });
    const done = mapPartDelta({
      state,
      sessionId: "s",
      part: {
        id: "bash-1",
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "ls" },
          metadata: { output: "a" },
        },
      },
    });
    expect(done.some((delta) => delta.kind === "command.outputSnapshot")).toBe(
      true,
    );
    expect(
      done.find((delta) => delta.kind === "command.outputSnapshot"),
    ).toMatchObject({ text: "a" });
  });
});
