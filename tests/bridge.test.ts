import { afterEach, describe, expect, it } from "vitest";
import {
  getCreateCount,
  handleLine,
  hydrateBoundSession,
  ingestOpenCodeEvent,
  recentUnknownLogLines,
  resetBridgeForTests,
  syncLiveTurnParts,
  syncSessionRevert,
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

    expect(identity?.params).toMatchObject({ providerThreadId: "ses_1" });

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

  it("errors when session.create has no id instead of returning empty identity", async () => {
    const fake = installFake();
    fake.client.createSession = async () => ({}) as never;
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "start",
          error: expect.objectContaining({
            message: expect.stringContaining("no session id"),
          }),
        }),
      ]),
    );
    expect(messages.some((message) => message.method === "thread/identity")).toBe(
      false,
    );
  });

  it("forks at a message checkpoint without session.create", async () => {
    const fake = installFake();
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "hi" }],
      },
    ]);
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams(),
    });
    await flush();
    const created = fake.calls.create;
    send({
      id: "fork",
      method: "thread/fork",
      params: sessionParams({
        threadId: "thr_fork",
        sourceProviderThreadId: "ses_1",
        sourceProviderCheckpointId: "u1",
      }),
    });
    await flush();
    expect(fake.calls.create).toBe(created);
    expect(fake.calls.fork).toEqual([
      { id: "ses_1", body: { messageID: "u1" } },
    ]);
    expect(messages.some((message) => message.id === "fork")).toBe(true);
    expect(
      messages.find((message) => message.id === "fork"),
    ).toMatchObject({
      result: { providerThreadId: "ses_fork_1" },
    });
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

  it("stamps providerCheckpointId on a completed turn", async () => {
    const fake = installFake();
    fake.promptImpl = async (id) => {
      fake.messages.set(id, [
        {
          info: { id: "u_chk", role: "user" },
          parts: [{ type: "text", text: "hi" }],
        },
        {
          info: {
            id: "a_chk",
            role: "assistant",
            providerID: "opencode",
            modelID: "gpt-4.1",
            tokens: {
              input: 100,
              output: 10,
              reasoning: 0,
              cache: { read: 900, write: 0 },
            },
          },
          parts: [{ type: "text", text: "yo" }],
        },
      ]);
      return {};
    };
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({ id: "turn", method: "turn/start", params: turnParams() });
    await flush();
    const deltas = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []),
    );
    expect(
      deltas.some(
        (delta) =>
          delta.kind === "turn.boundary" &&
          delta.status === "completed" &&
          delta.providerCheckpointId === "a_chk",
      ),
    ).toBe(true);
    expect(
      deltas.some(
        (delta) =>
          delta.kind === "contextWindow" &&
          delta.used === 1000 &&
          delta.size === 1_047_576,
      ),
    ).toBe(true);
  });

  it("settles Read/Task rows even if session.idle fires first (ISC-71)", async () => {
    const fake = installFake();
    fake.promptImpl = async (id) => {
      fake.messages.set(id, [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "read" }],
        },
        {
          info: { role: "assistant" },
          parts: [
            {
              id: "r1",
              type: "tool",
              tool: "read",
              state: {
                status: "completed",
                input: { filePath: "package.json" },
              },
            },
          ],
        },
        {
          info: { role: "assistant" },
          parts: [
            {
              id: "k1",
              type: "tool",
              tool: "task",
              state: { status: "completed", title: "general" },
            },
          ],
        },
        {
          info: { role: "assistant" },
          parts: [{ id: "t1", type: "text", text: "bb-plugin-opencode" }],
        },
      ]);
      fake.emit({ type: "session.idle", properties: { sessionID: id } });
      return {};
    };
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({ id: "turn", method: "turn/start", params: turnParams() });
    await flush();
    const deltas = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []),
    );
    expect(
      deltas.some(
        (delta) =>
          delta.kind === "item.open" &&
          (delta.item as { type?: string } | undefined)?.type === "fileRead",
      ),
    ).toBe(true);
    expect(
      deltas.some(
        (delta) =>
          delta.kind === "item.open" &&
          (delta.item as { type?: string } | undefined)?.type === "delegation",
      ),
    ).toBe(true);
    expect(
      deltas.some(
        (delta) =>
          delta.kind === "item.textDelta" &&
          delta.text === "bb-plugin-opencode",
      ),
    ).toBe(true);
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

  it("polls live session parts when SSE is silent", async () => {
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
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "go" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ id: "t1", type: "text", text: "SMOKE_OK" }],
      },
    ]);
    messages.length = 0;
    expect(await syncLiveTurnParts("ses_1")).toBe(true);
    const texts = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; text?: string }> })
          ?.deltas ?? []
      )
        .filter((delta) => delta.kind === "item.textDelta")
        .map((delta) => delta.text);
    });
    expect(texts).toContain("SMOKE_OK");
    expect(await syncLiveTurnParts("ses_1")).toBe(false);
  });

  it("does not stamp OpenCode placeholder titles onto BB", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    const session = fake.sessions.get("ses_1");
    if (session) session.title = "New session - 2026-07-06T22:33:57.776Z";
    messages.length = 0;
    expect(await syncSessionTitle("ses_1")).toBe(false);
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string }> })
          ?.deltas;
        return deltas?.some((delta) => delta.kind === "thread.name");
      }),
    ).toBe(false);
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

  it("rehydrates in place when the OpenCode revert cursor changes", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "sup" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ type: "text", text: "hey" }],
      },
    ]);
    const session = fake.sessions.get("ses_1");
    if (session) session.revert = { messageID: "u1" };
    messages.length = 0;
    expect(await syncSessionRevert("ses_1")).toBe(true);
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string }> })
          ?.deltas;
        return deltas?.some((delta) => delta.kind === "session.reset");
      }),
    ).toBe(true);
    expect(await syncSessionRevert("ses_1")).toBe(false);
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

  it("ignores session.updated placeholder titles until ensureTitle lands", async () => {
    installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "session.updated",
      properties: {
        sessionID: "ses_1",
        title: "New session - 2026-07-06T22:33:57.776Z",
      },
    });
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string }> })
          ?.deltas;
        return deltas?.some((delta) => delta.kind === "thread.name");
      }),
    ).toBe(false);
    await ingestOpenCodeEvent({
      type: "session.updated",
      properties: { sessionID: "ses_1", title: "Ask a yes or no question" },
    });
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string; name?: string }> })
          ?.deltas;
        return deltas?.some(
          (delta) =>
            delta.kind === "thread.name" && delta.name === "Ask a yes or no question",
        );
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
          (delta) => delta.kind === "turn.boundary" && delta.status === "failed",
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

  it("surfaces a 1.18 permission.updated ask as a card (ISC-33 dialect)", async () => {
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
      type: "permission.updated",
      properties: {
        id: "p-118",
        sessionID: "ses_1",
        type: "bash",
        pattern: "echo *",
        callID: "call_118",
        metadata: { command: "echo ISC33_PERM_PROBE" },
      },
    });
    expect(fake.calls.reply).toEqual([]);
    expect(
      messages.some((message) => message.method === "interaction/request"),
    ).toBe(true);
  });

  it("surfaces a 1.18 permission.v2.asked edit as a card", async () => {
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
      type: "permission.v2.asked",
      properties: {
        id: "per_v2",
        sessionID: "ses_1",
        action: "edit",
        resources: ["scratch/isc33-probe.txt"],
        source: { type: "tool", messageID: "msg_1", callID: "call_v2" },
      },
    });
    expect(fake.calls.reply).toEqual([]);
    expect(
      messages.some((message) => message.method === "interaction/request"),
    ).toBe(true);
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

  it("cards OpenCode question.v2.asked as native user_question", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({ id: "turn", method: "turn/start", params: turnParams() });
    await flush();
    await ingestOpenCodeEvent({
      type: "question.v2.asked",
      properties: {
        id: "que_1",
        sessionID: "ses_1",
        questions: [
          {
            question: "Is the plugin done?",
            header: "Done?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    });
    const request = messages.find(
      (message) => message.method === "interaction/request",
    );
    expect(request).toMatchObject({
      id: "oc-q-que_1",
      params: {
        payload: {
          kind: "user_question",
          questions: [{ id: "que_1:q1", prompt: "Is the plugin done?" }],
        },
      },
    });
    send({
      id: "oc-q-que_1",
      result: {
        kind: "user_answer",
        answers: { "que_1:q1": { selected: ["Yes"] } },
      },
    });
    await flush();
    expect(fake.calls.questionReply).toEqual([
      { requestID: "que_1", answers: [["Yes"]] },
    ]);
  });

  it("routes a listed /command through session.command (ISC-81)", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "/init repo", mentions: [] }],
      }),
    });
    await flush();
    expect(fake.calls.prompt).toBe(0);
    expect(fake.calls.command).toEqual([
      {
        id: "ses_1",
        body: { command: "init", arguments: "repo", agent: "build" },
      },
    ]);
  });

  it("does not route a slash send that also has an attachment (ISC-83)", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [
          { type: "text", text: "/init", mentions: [] },
          { type: "localFile", path: "/tmp/note.md", name: "note.md" },
        ],
      }),
    });
    await flush();
    expect(fake.calls.command).toEqual([]);
    expect(fake.calls.prompt).toBe(1);
  });

  it("forwards an unknown slash as a prompt (ISC-82)", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "/not-a-command", mentions: [] }],
      }),
    });
    await flush();
    expect(fake.calls.command).toEqual([]);
    expect(fake.lastPrompt?.body).toMatchObject({
      parts: [{ type: "text", text: "/not-a-command" }],
    });
  });

  it("appends BB skills after skills/configure (ISC-84, ISC-85)", async () => {
    const fake = installFake();
    send({
      id: "skills",
      method: "skills/configure",
      params: {
        roots: [
          {
            id: "plugin",
            path: "/tmp/bb-skills",
            skills: [{ name: "bb-cli", description: "Use bb" }],
          },
        ],
      },
    });
    await flush();
    expect(messages.find((message) => message.id === "skills")).toMatchObject({
      result: { ok: true },
    });
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "hello", mentions: [] }],
      }),
    });
    await flush();
    const texts = (fake.lastPrompt?.body.parts as Array<{ text?: string }>) ?? [];
    expect(texts.some((part) => part.text?.includes("bb-cli: Use bb"))).toBe(
      true,
    );
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

  it("rejects an unmappable ask that still has an id", async () => {
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
    await ingestOpenCodeEvent({
      type: "permission.asked",
      properties: { id: "p-bad", sessionID: "ses_1", permission: "bash" },
    });
    expect(fake.calls.reply).toEqual([{ requestID: "p-bad", reply: "reject" }]);
  });

  it("forwards BB reasoningLevel as OpenCode variant", async () => {
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
      params: turnParams({
        options: {
          ...fullOptions,
          reasoningLevel: "high",
          providerOptions: { agent: "build" },
        },
      }),
    });
    await flush();
    expect(fake.lastPrompt?.body).toMatchObject({ variant: "high" });
  });
});
