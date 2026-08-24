import { describe, expect, it } from "vitest";
import {
  createMapDeltaState,
  mapPartDelta,
  mapSessionNextEvent,
} from "../src/map-delta.js";

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
        state: {
          status: "running",
          title: "Task",
          input: { description: "Explore" },
          metadata: { sessionID: "ses_child" },
        },
      },
    });
    expect(tool[0]).toMatchObject({
      kind: "item.open",
      item: { type: "delegation", label: "Explore", childRef: "ses_child" },
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
    const edit = mapPartDelta({
      state: createMapDeltaState(),
      sessionId: "s",
      part: {
        id: "edit-1",
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: {
            filePath: "src/a.ts",
            oldString: "a",
            newString: "b",
          },
        },
      },
    });
    expect(edit[0]).toMatchObject({
      kind: "item.open",
      item: {
        type: "fileChange",
        changes: [{ path: "src/a.ts", kind: "update" }],
      },
    });
    const search = mapPartDelta({
      state: createMapDeltaState(),
      sessionId: "s",
      part: {
        id: "web-1",
        type: "tool",
        tool: "websearch",
        state: { status: "completed", input: { query: "opencode" } },
      },
    });
    expect(search[0]).toMatchObject({
      kind: "item.open",
      item: { type: "webSearch", queries: ["opencode"] },
    });
  });

  it("nests child parts under the Task item via parentRef", () => {
    const deltas = mapPartDelta({
      state: createMapDeltaState(),
      sessionId: "ses_child",
      parentRef: "task-1",
      part: {
        id: "read-1",
        type: "tool",
        tool: "read",
        state: { status: "running", input: { filePath: "ISA.md" } },
      },
    });
    expect(deltas[0]).toMatchObject({
      kind: "item.open",
      key: { providerItemId: "read-1", parentRef: "task-1" },
      item: { type: "fileRead", path: "ISA.md" },
    });
  });

  it("does not emit a generic row for OpenCode todo tools (ISC-93)", () => {
    const deltas = mapPartDelta({
      state: createMapDeltaState(),
      sessionId: "s",
      part: {
        id: "todo-1",
        type: "tool",
        tool: "todowrite",
        state: { status: "completed", output: "ok" },
      },
    });
    expect(deltas).toEqual([]);
  });

  it("does not emit a generic row for OpenCode question tools", () => {
    const deltas = mapPartDelta({
      state: createMapDeltaState(),
      sessionId: "s",
      part: {
        id: "q1",
        type: "tool",
        tool: "question",
        state: { status: "running" },
      },
    });
    expect(deltas).toEqual([]);
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

  it("ignores retry and step parts without tallying them as tools", () => {
    const state = createMapDeltaState();
    expect(
      mapPartDelta({
        state,
        sessionId: "s",
        part: { id: "r1", type: "retry", attempt: 1 },
      }),
    ).toEqual([]);
    expect(
      mapPartDelta({
        state,
        sessionId: "s",
        part: { id: "s1", type: "step-finish" },
      }),
    ).toEqual([]);
    expect(state.unknownTally.size).toBe(0);
  });

  it("snapshots bash stdout onto the same command item", () => {
    const state = createMapDeltaState();
    mapPartDelta({
      state,
      sessionId: "s",
      part: {
        id: "bash-1",
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "xcodebuild", workdir: "/tmp/app" } },
      },
    });
    const streamed = mapPartDelta({
      state,
      sessionId: "s",
      part: {
        id: "bash-1",
        type: "tool",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "xcodebuild", workdir: "/tmp/app" },
          metadata: { stdout: "Compiling Foo.swift\n" },
        },
      },
    });
    expect(streamed).toContainEqual({
      kind: "command.outputSnapshot",
      key: { providerItemId: "bash-1" },
      text: "Compiling Foo.swift\n",
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
    expect(first[0]).toMatchObject({ key: { providerItemId: "bash-1" } });
    expect(second[0]).toMatchObject({
      kind: "command.outputSnapshot",
      key: { providerItemId: "bash-1" },
      text: "a",
    });
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
    expect(done.map((delta) => delta.kind)).toEqual(["item.close"]);
  });

  it("does not open a bash row until the command is known", () => {
    const state = createMapDeltaState();
    expect(
      mapPartDelta({
        state,
        sessionId: "s",
        part: {
          id: "prt_1",
          callID: "call_1",
          type: "tool",
          tool: "bash",
          state: { status: "running" },
        },
      }),
    ).toEqual([]);
    expect(
      mapSessionNextEvent({
        type: "session.next.tool.called",
        state,
        sessionId: "s",
        properties: { callID: "call_1", tool: "bash" },
      }),
    ).toEqual([]);
    const opened = mapPartDelta({
      state,
      sessionId: "s",
      part: {
        id: "prt_1",
        callID: "call_1",
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "echo hi" } },
      },
    });
    expect(opened[0]).toMatchObject({
      kind: "item.open",
      key: { providerItemId: "call_1" },
      item: { type: "command", command: "echo hi" },
    });
  });

  it("does not reopen a tool already mapped from a poll snapshot", () => {
    const state = createMapDeltaState();
    const first = mapPartDelta({
      state,
      sessionId: "s",
      part: {
        id: "read-1",
        type: "tool",
        tool: "read",
        state: { status: "running", input: { filePath: "package.json" } },
      },
    });
    const again = mapPartDelta({
      state,
      sessionId: "s",
      part: {
        id: "read-1",
        type: "tool",
        tool: "read",
        state: { status: "running", input: { filePath: "package.json" } },
      },
    });
    expect(first).toHaveLength(1);
    expect(again).toEqual([]);
    const done = mapPartDelta({
      state,
      sessionId: "s",
      part: {
        id: "read-1",
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "package.json" } },
      },
    });
    expect(done.map((delta) => delta.kind)).toEqual(["item.close"]);
  });

  it("maps session.next text deltas", () => {
    const state = createMapDeltaState();
    const first = mapSessionNextEvent({
      type: "session.next.text.delta",
      properties: { textID: "t1", delta: "Hi" },
      state,
      sessionId: "s",
    });
    const second = mapSessionNextEvent({
      type: "session.next.text.delta",
      properties: { textID: "t1", delta: " there" },
      state,
      sessionId: "s",
    });
    expect(first[0]).toMatchObject({ text: "Hi" });
    expect(second[0]).toMatchObject({ text: " there" });
  });
});
