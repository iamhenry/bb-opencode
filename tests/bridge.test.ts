import { afterEach, describe, expect, it } from "vitest";
import {
  getCreateCount,
  handleLine,
  hydrateBoundSession,
  ingestOpenCodeEvent,
  recentUnknownLogLines,
  resetBridgeForTests,
  syncSessionTitle,
} from "../src/bridge.js";
import { createFakeOpenCode } from "./fake-opencode.js";

const fullOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

function sessionParams(extra: Record<string, unknown> = {}) {
  return {
    threadId: "thr_1",
    cwd: "/tmp/a",
    instructionMode: "append",
    options: fullOptions,
    ...extra,
  };
}

function turnParams(extra: Record<string, unknown> = {}) {
  return {
    threadId: "thr_1",
    providerThreadId: "ses_1",
    clientRequestId: "req_1",
    input: [{ type: "text", text: "ping", mentions: [] }],
    options: { ...fullOptions, providerOptions: { agent: "build" } },
    ...extra,
  };
}

function send(message: Record<string, unknown>): void {
  handleLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("provider bridge", () => {
  const messages: Array<Record<string, unknown>> = [];

  afterEach(() => {
    resetBridgeForTests();
    messages.length = 0;
  });

  function installFake() {
    const fake = createFakeOpenCode();
    resetBridgeForTests({
      acquire: () => fake.client,
      attach: async () => ({ url: fake.client.url, pid: 1, port: 9 }),
      write: (message) => {
        messages.push(message);
      },
    });
    return fake;
  }

  it("answers turn/steer with -32601 (ISC-20)", () => {
    installFake();
    send({
      id: 1,
      method: "turn/steer",
      params: turnParams({ expectedTurnId: "turn_1" }),
    });
    expect(messages[0]).toMatchObject({
      id: 1,
      error: { code: -32601 },
    });
  });

  it("starts a session once and resumes without create (ISC-9, ISC-10, ISC-10.1)", async () => {
    const fake = installFake();
    send({
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: 2,
        client: { name: "test", version: "0" },
      },
    });
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams(),
    });
    await flush();
    expect(fake.calls.create).toBe(1);
    const identity = messages.find((message) => message.method === "thread/identity");
    expect(identity).toMatchObject({
      params: { threadId: "thr_1" },
    });

    const createAfterStart = fake.calls.create;
    send({
      id: "resume",
      method: "thread/resume",
      params: sessionParams({ providerThreadId: "ses_1" }),
    });
    await flush();
    expect(fake.calls.create).toBe(createAfterStart);
    expect(fake.calls.get).toBeGreaterThan(0);
    const resumeDeltas = messages.filter(
      (message) => message.method === "thread/delta",
    );
    expect(
      resumeDeltas.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string }> })
          ?.deltas;
        return deltas?.some((delta) => delta.kind === "session.reset");
      }),
    ).toBe(true);
  });

  it("issues session.prompt once per turn/start (ISC-14, ISC-29.1)", async () => {
    const fake = installFake();
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams(),
    });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams(),
    });
    await flush();
    expect(fake.calls.prompt).toBe(1);
    expect(fake.lastPrompt?.body).toMatchObject({ agent: "build" });
  });

  it("does not create a session when Task starts (ISC-71.1)", async () => {
    const fake = installFake();
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams(),
    });
    await flush();
    const created = getCreateCount();
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "task-1",
          type: "tool",
          tool: "task",
          sessionID: "ses_1",
          state: { status: "running" },
        },
      },
    });
    expect(getCreateCount()).toBe(created);
    expect(fake.calls.create).toBe(1);
  });

  it("does not bound the parent when a child goes idle (ISC-73)", async () => {
    installFake();
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams(),
    });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({ input: [{ type: "text", text: "go", mentions: [] }] }),
    });
    await flush();
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "child_1" },
    });
    const boundaries = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string }> })?.deltas ?? []
      ).filter((delta) => delta.kind === "turn.boundary");
    });
    expect(boundaries).toHaveLength(0);
  });

  it("tallies unknown events without failing the turn (ISC-25)", async () => {
    installFake();
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams(),
    });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({ input: [{ type: "text", text: "go", mentions: [] }] }),
    });
    await flush();
    await ingestOpenCodeEvent({
      type: "mystery.event",
      properties: { sessionID: "ses_1" },
    });
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await flush();
    expect(recentUnknownLogLines().join(" ")).toContain("mystery.event");
  });

  it("refetches and does not retry prompt after a failed send (ISC-24, ISC-32)", async () => {
    const fake = installFake();
    fake.promptImpl = async () => {
      throw new Error("busy");
    };
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams(),
    });
    await flush();
    const prompts = fake.calls.prompt;
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({ input: [{ type: "text", text: "go", mentions: [] }] }),
    });
    await flush();
    expect(fake.calls.prompt).toBe(prompts + 1);
    expect(fake.calls.messages).toBeGreaterThan(0);
  });

  it("adopts without session.create (ISC-42.1)", async () => {
    const fake = installFake();
    fake.sessions.set("existing", { id: "existing", directory: "/tmp/a" });
    fake.messages.set("existing", []);
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        options: { ...fullOptions, providerOptions: { adoptSessionId: "existing" } },
      }),
    });
    await flush();
    expect(fake.calls.create).toBe(0);
    expect(getCreateCount()).toBe(0);
  });

  it("stops the parent and listed live children (ISC-19)", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    fake.sessions.set("child_1", {
      id: "child_1",
      directory: "/tmp/a",
      parentID: "ses_1",
    });
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({ input: [{ type: "text", text: "go", mentions: [] }] }),
    });
    await flush();
    await ingestOpenCodeEvent({
      type: "session.created",
      properties: { sessionID: "child_1", parentID: "ses_1" },
    });
    send({
      id: "stop",
      method: "thread/stop",
      params: {
        threadId: "thr_1",
        providerThreadId: "ses_1",
        intent: "interrupt",
      },
    });
    await flush();
    expect(fake.calls.abort).toBeGreaterThanOrEqual(2);
    const boundaries = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; status?: string }> })
          ?.deltas ?? []
      ).filter((delta) => delta.kind === "turn.boundary");
    });
    expect(boundaries.some((delta) => delta.status === "interrupted")).toBe(true);
  });

  it("isolates child session items from the parent thread (ISC-22)", async () => {
    installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({ input: [{ type: "text", text: "go", mentions: [] }] }),
    });
    await flush();
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "child_1",
        part: { id: "c", type: "text", text: "from-child", sessionID: "child_1" },
      },
    });
    const texts = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; text?: string }> })
          ?.deltas ?? []
      )
        .filter((delta) => delta.kind === "item.textDelta")
        .map((delta) => delta.text);
    });
    expect(texts).not.toContain("from-child");
  });

  it("updates the BB title when OpenCode title changes without SSE (ISC-12)", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    const session = fake.sessions.get("ses_1");
    if (session) session.title = "Polled title";
    messages.length = 0;
    await syncSessionTitle("ses_1");
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string; name?: string }> })
          ?.deltas;
        return deltas?.some(
          (delta) => delta.kind === "thread.name" && delta.name === "Polled title",
        );
      }),
    ).toBe(true);
  });

  it("hydrates the BB timeline after revert (ISC-30)", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    fake.messages.set("ses_1", [
      {
        info: { id: "m1", role: "assistant" },
        parts: [{ id: "t1", type: "text", text: "after-revert" }],
      },
    ]);
    messages.length = 0;
    expect(await hydrateBoundSession("ses_1")).toBe(true);
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string }> })?.deltas;
        return deltas?.some((delta) => delta.kind === "session.reset");
      }),
    ).toBe(true);
  });

  it("updates the BB title from session.updated (ISC-12)", async () => {
    installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "session.updated",
      properties: { sessionID: "ses_1", title: "Renamed live" },
    });
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string; name?: string }> })
          ?.deltas;
        return deltas?.some(
          (delta) => delta.kind === "thread.name" && delta.name === "Renamed live",
        );
      }),
    ).toBe(true);
  });

  it("errors live turns when the event stream dies (ISC-26)", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({ input: [{ type: "text", text: "go", mentions: [] }] }),
    });
    await flush();
    messages.length = 0;
    await ingestOpenCodeEvent({ type: "server.disconnected" });
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string; status?: string }> })
          ?.deltas;
        return deltas?.some(
          (delta) => delta.kind === "turn.boundary" && delta.status === "error",
        );
      }),
    ).toBe(true);
  });

  it("auto-approves only under full and writes once (ISC-35)", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    await ingestOpenCodeEvent({
      type: "permission.asked",
      properties: {
        id: "p-full",
        sessionID: "ses_1",
        permission: "bash",
        metadata: { command: "ls" },
      },
    });
    expect(fake.calls.reply).toEqual([{ requestID: "p-full", reply: "once" }]);
  });

  it("does not auto-approve under accept-edits (ISC-36)", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        options: {
          permissionMode: "accept-edits",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
      }),
    });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: {
        ...turnParams({
          options: {
            permissionMode: "accept-edits",
            permissionScope: "full",
            approvalReviewer: null,
            permissionEscalation: null,
            providerOptions: { agent: "build" },
          },
        }),
      },
    });
    await flush();
    await ingestOpenCodeEvent({
      type: "permission.asked",
      properties: {
        id: "p-edit",
        sessionID: "ses_1",
        permission: "bash",
        metadata: { command: "ls" },
      },
    });
    expect(fake.calls.reply).toEqual([]);
    expect(
      messages.some(
        (message) => message.method === "interaction/request",
      ),
    ).toBe(true);
  });

  it("forwards @subagent text unchanged (ISC-77)", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "ask @general to look", mentions: [] }],
      }),
    });
    await flush();
    expect(fake.lastPrompt?.body).toMatchObject({
      agent: "build",
      parts: [{ type: "text", text: "ask @general to look" }],
    });
    expect(fake.calls.create).toBe(1);
  });

  it("lists OpenCode models and never agent ids (ISC-27, ISC-27.1)", async () => {
    installFake();
    send({
      id: "models",
      method: "model/list",
      params: { cwd: "/tmp/a" },
    });
    await flush();
    const result = messages.find((message) => message.id === "models")?.result as {
      models?: Array<{ id: string }>;
    };
    const ids = (result?.models ?? []).map((model) => model.id);
    expect(ids).toContain("opencode/gpt-4.1");
    expect(ids).not.toContain("build");
    expect(ids).not.toContain("plan");
    const names = (result?.models ?? []).map(
      (model) => (model as { displayName?: string }).displayName,
    );
    expect(names).toContain("opencode/gpt-4.1");
  });

  it("refuses a queued agent that is no longer selectable (ISC-29.5)", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        options: {
          ...fullOptions,
          providerOptions: { agent: "explore" },
        },
      }),
    });
    await flush();
    expect(fake.calls.prompt).toBe(0);
  });

  it("does not approve unknown permission asks under full (ISC-64)", async () => {
    const fake = installFake();
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams(),
    });
    await flush();
    await ingestOpenCodeEvent({
      type: "permission.asked",
      properties: { permission: "bash" },
    });
    expect(fake.calls.reply).toEqual([]);
  });
});
