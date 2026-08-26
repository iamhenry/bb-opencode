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
import { TASK_CHILD_BIND_TEXT } from "../src/task-thread.js";
import { writeLivePermissionMode } from "../src/permission-mode-live.js";

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

  it("injects turn/steer when BB steer-on-Enter is on (ISC-20)", async () => {
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
    const prompts = fake.calls.prompt;
    const asyncPrompts = fake.calls.promptAsync;
    messages.length = 0;
    send({
      id: "steer",
      method: "turn/steer",
      params: turnParams({
        expectedTurnId: "turn_1",
        clientRequestId: "req_steer",
        input: [{ type: "text", text: "use the v2 API", mentions: [] }],
        options: {
          ...fullOptions,
          providerOptions: { agent: "build", steerDelivery: "inject" },
        },
      }),
    });
    await flush();
    expect(messages[0]).toMatchObject({ id: "steer", result: {} });
    const deltas = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []),
    );
    expect(deltas).toContainEqual({
      kind: "input.accepted",
      clientRequestId: "req_steer",
    });
    expect(deltas.some((delta) => delta.kind === "turn.boundary")).toBe(false);
    expect(fake.calls.prompt).toBe(prompts);
    expect(fake.calls.promptAsync).toBe(asyncPrompts + 1);
    expect(fake.lastPrompt?.body).toMatchObject({
      agent: "build",
      parts: [{ type: "text", text: "use the v2 API" }],
    });
  });

  it("queues turn/steer until the live turn settles when steer-on-Enter is off", async () => {
    const fake = installFake();
    let release: (() => void) | undefined;
    fake.promptImpl = () =>
      new Promise((resolve) => {
        release = () => resolve({});
      });
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({ input: [{ type: "text", text: "go", mentions: [] }] }),
    });
    await flush();
    const prompts = fake.calls.prompt;
    send({
      id: "steer",
      method: "turn/steer",
      params: turnParams({
        expectedTurnId: "turn_1",
        clientRequestId: "req_queue",
        input: [{ type: "text", text: "after this, update the README", mentions: [] }],
      }),
    });
    await flush();
    expect(fake.calls.promptAsync).toBe(1);
    expect(fake.calls.prompt).toBe(prompts);
    release?.();
    fake.promptImpl = undefined;
    await flush();
    expect(fake.calls.promptAsync).toBe(2);
    expect(fake.lastPrompt?.body).toMatchObject({
      agent: "build",
      parts: [{ type: "text", text: "after this, update the README" }],
    });
  });

  it("parks turn/steer that arrives before turn/start issues the prompt", async () => {
    const fake = installFake();
    let release: (() => void) | undefined;
    fake.promptImpl = () =>
      new Promise((resolve) => {
        release = () => resolve({});
      });
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({ input: [{ type: "text", text: "commit these", mentions: [] }] }),
    });
    send({
      id: "steer",
      method: "turn/steer",
      params: turnParams({
        expectedTurnId: "turn_1",
        clientRequestId: "req_steer",
        input: [{ type: "text", text: "and push", mentions: [] }],
      }),
    });
    await flush();
    expect(fake.calls.promptAsync).toBe(1);
    expect(fake.lastPrompt?.body).toMatchObject({
      parts: [{ type: "text", text: "commit these" }],
    });
    const deltas = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []),
    );
    expect(deltas).toContainEqual({
      kind: "input.accepted",
      clientRequestId: "req_steer",
    });
    release?.();
    fake.promptImpl = undefined;
    await flush();
    expect(fake.calls.promptAsync).toBe(2);
    expect(fake.lastPrompt?.body).toMatchObject({
      parts: [{ type: "text", text: "and push" }],
    });
  });

  it("flushes a same-tick steer after promptAsync returns idle immediately", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "commit these", mentions: [] }],
      }),
    });
    send({
      id: "steer",
      method: "turn/steer",
      params: turnParams({
        expectedTurnId: "turn_1",
        clientRequestId: "req_fast",
        input: [{ type: "text", text: "and push", mentions: [] }],
      }),
    });
    await flush();
    expect(fake.calls.promptAsync).toBe(2);
    expect(fake.lastPrompt?.body).toMatchObject({
      parts: [{ type: "text", text: "and push" }],
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
    messages.length = 0;
    send({
      id: "resume",
      method: "thread/resume",
      params: sessionParams({ providerThreadId: "ses_1" }),
    });
    await flush();
    expect(fake.calls.create).toBe(createAfterStart);
    expect(fake.calls.get).toBeGreaterThan(0);
    const resumeDeltas = messages.filter(
      (message) =>
        message.method === "thread/delta" &&
        (message.params as { threadId?: string }).threadId === "thr_1",
    );
    const kinds = resumeDeltas.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<{ kind: string }> }).deltas ?? []).map(
          (delta) => delta.kind,
        ),
    );
    expect(kinds).not.toContain("session.reset");
    expect(kinds).not.toContain("turn.open");
  });

  it("joins a running session on resume without replaying history", async () => {
    const fake = installFake();
    fake.sessions.set("ses_1", { id: "ses_1" });
    fake.runningIds.add("ses_1");
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "keep going" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ id: "t1", type: "text", text: "working" }],
      },
    ]);
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        options: { ...fullOptions, providerOptions: { adoptSessionId: "ses_1" } },
      }),
    });
    await flush();
    messages.length = 0;
    send({
      id: "resume",
      method: "thread/resume",
      params: sessionParams({ providerThreadId: "ses_1" }),
    });
    await flush();
    const kinds = messages
      .filter((message) => message.method === "thread/delta")
      .flatMap(
        (message) =>
          ((message.params as { deltas?: Array<{ kind: string }> }).deltas ?? []).map(
            (delta) => delta.kind,
          ),
      );
    expect(kinds).not.toContain("session.reset");
    expect(kinds).toContain("turn.open");
    expect(kinds).not.toContain("turn.boundary");
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
    expect(fake.calls.prompt).toBe(0);
    expect(fake.calls.promptAsync).toBe(1);
    expect(fake.lastPrompt?.body).toMatchObject({ agent: "build" });
  });

  it("pins the composer model on every session.prompt", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        options: {
          ...fullOptions,
          model: "xai/grok-4.6",
          providerOptions: { agent: "build" },
        },
      }),
    });
    await flush();
    expect(fake.lastPrompt?.body).toMatchObject({
      agent: "build",
      model: { providerID: "xai", modelID: "grok-4.6" },
    });
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

  it("keeps persisted assistant messages before late SSE text at idle", async () => {
    const fake = installFake();
    const readMessages = fake.client.sessionMessages.bind(fake.client);
    let settling = false;
    let releaseSettle: (() => void) | undefined;
    let markSettleStarted: (() => void) | undefined;
    const settleStarted = new Promise<void>((resolve) => {
      markSettleStarted = resolve;
    });
    fake.client.sessionMessages = async (id) => {
      if (!settling) return readMessages(id);
      markSettleStarted?.();
      await new Promise<void>((resolve) => {
        releaseSettle = resolve;
      });
      return fake.messages.get(id) ?? [];
    };
    fake.promptImpl = async (id) => {
      fake.messages.set(id, [
        {
          info: { id: "u1", role: "user" },
          parts: [{ id: "user-text", type: "text", text: "ping" }],
        },
        {
          info: { id: "a1", role: "assistant" },
          parts: [{ id: "goal-text", type: "text", text: "GOAL first" }],
        },
        {
          info: { id: "a2", role: "assistant" },
          parts: [{ id: "final-text", type: "text", text: "final answer" }],
        },
      ]);
      settling = true;
      return {};
    };

    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({ id: "turn", method: "turn/start", params: turnParams() });
    await settleStarted;
    messages.length = 0;
    fake.emit({
      type: "session.next.text.delta",
      properties: {
        sessionID: "ses_1",
        textID: "late-final",
        delta: "final answer",
      },
    });
    await Promise.resolve();
    expect(messages).toHaveLength(0);

    releaseSettle?.();
    await flush();
    const text = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })?.deltas ?? [])
          .filter((delta) => delta.kind === "item.textDelta")
          .map((delta) => delta.text),
    );
    expect(text).toEqual(["GOAL first", "final answer"]);
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

  it("nests Task child tools without duplicating child prose", async () => {
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
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "task-1",
          callID: "task-call-1",
          type: "tool",
          tool: "task",
          sessionID: "ses_1",
          state: {
            status: "running",
            title: "Task",
            input: { description: "Trace todo event flow" },
            metadata: { sessionID: "ses_child" },
          },
        },
      },
    });
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        parentID: "ses_1",
        sessionID: "ses_child",
        part: {
          id: "text-1",
          type: "text",
          text: "final child prose",
          sessionID: "ses_child",
        },
      },
    });
    await ingestOpenCodeEvent({
      type: "message.part.delta",
      properties: {
        parentID: "ses_1",
        sessionID: "ses_child",
        part: {
          id: "reasoning-1",
          type: "reasoning-delta",
          text: "private child reasoning",
          sessionID: "ses_child",
        },
      },
    });
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: {
        parentID: "ses_1",
        sessionID: "ses_child",
        textID: "next-text-1",
        delta: "next child prose",
      },
    });
    await ingestOpenCodeEvent({
      type: "session.next.reasoning.delta",
      properties: {
        parentID: "ses_1",
        sessionID: "ses_child",
        reasoningID: "next-reasoning-1",
        delta: "next child reasoning",
      },
    });
    expect(
      messages.flatMap(
        (message) =>
          ((message.params as { deltas?: Array<Record<string, unknown>> })
            ?.deltas ?? []),
      ),
    ).toEqual([]);
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        parentID: "ses_1",
        sessionID: "ses_child",
        part: {
          id: "read-1",
          type: "tool",
          tool: "read",
          sessionID: "ses_child",
          state: { status: "running", input: { filePath: "ISA.md" } },
        },
      },
    });
    const deltas = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []),
    );
    expect(
      deltas.some(
        (delta) =>
          delta.kind === "turn.open" &&
          delta.providerTurnId === "ses_child" &&
          delta.parentRef === "task-call-1",
      ),
    ).toBe(true);
    expect(
      deltas.some((delta) => {
        const item = delta.item as { type?: string; path?: string } | undefined;
        const key = delta.key as { parentRef?: string } | undefined;
        return (
          delta.kind === "item.open" &&
          item?.type === "fileRead" &&
          item.path === "ISA.md" &&
          key?.parentRef === "task-call-1"
        );
      }),
    ).toBe(true);
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
    expect(fake.calls.promptAsync).toBe(prompts + 1);
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

  it("does not remint same-turn text when poll sees a different part id", async () => {
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
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: {
        sessionID: "ses_1",
        textID: "sse_1",
        delta: "LIVE",
      },
    });
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "go" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ id: "persist_1", type: "text", text: "LIVE" }],
      },
    ]);
    messages.length = 0;
    expect(await syncLiveTurnParts("ses_1")).toBe(false);
    const texts = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; text?: string }> })
          ?.deltas ?? []
      )
        .filter((delta) => delta.kind === "item.textDelta")
        .map((delta) => delta.text);
    });
    expect(texts).not.toContain("LIVE");
  });

  it("closes streamed text under its SSE id when persist id differs", async () => {
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
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: {
        sessionID: "ses_1",
        textID: "sse_1",
        delta: "LIVE",
      },
    });
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "persist_1", type: "text", text: "LIVE" },
      },
    });
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await flush();
    const kinds = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; text?: string; key?: { channel?: string; providerItemId?: string }; item?: { text?: string } }> })
          ?.deltas ?? []
      )
        .filter(
          (delta) =>
            delta.kind === "item.textDelta" || delta.kind === "item.close" || delta.kind === "item.textClose",
        )
        .map((delta) => `${delta.kind}:${delta.key?.providerItemId ?? delta.key?.channel ?? ""}:${delta.item?.text ?? delta.text ?? ""}`);
    });
    expect(kinds.some((row) => row.includes("persist_1"))).toBe(false);
    expect(kinds.filter((row) => row === "item.close:assistant:0:LIVE")).toHaveLength(1);
  });

  it("closes message.part text-delta when persist id differs", async () => {
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
    await ingestOpenCodeEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        part: { id: "sse_1", type: "text-delta" },
        delta: "LIVE",
      },
    });
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "go" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ id: "persist_1", type: "text", text: "LIVE" }],
      },
    ]);
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "persist_1", type: "text", text: "LIVE" },
      },
    });
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await flush();
    const closes = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; key?: { channel?: string; providerItemId?: string }; item?: { text?: string } }> })
          ?.deltas ?? []
      )
        .filter((delta) => delta.kind === "item.close" || delta.kind === "item.textClose")
        .map((delta) => delta.key?.providerItemId ?? delta.key?.channel);
    });
    expect(closes).toEqual(["assistant:0"]);
  });

  it("does not remint FIRST after an empty text.ended", async () => {
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
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "sse_1", delta: "FIRST" },
    });
    await ingestOpenCodeEvent({
      type: "session.next.text.ended",
      properties: { sessionID: "ses_1", textID: "sse_1", text: "" },
    });
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "go" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ id: "persist_1", type: "text", text: "FIRST" }],
      },
    ]);
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "persist_1", type: "text", text: "FIRST" },
      },
    });
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await flush();
    const closes = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; text?: string; key?: { channel?: string; providerItemId?: string }; item?: { text?: string } }> })
          ?.deltas ?? []
      )
        .filter((delta) => delta.kind === "item.close" || delta.kind === "item.textClose")
        .map((delta) => `${delta.key?.providerItemId ?? delta.key?.channel}:${delta.item?.text ?? delta.text ?? ""}`);
    });
    expect(closes).toEqual(["assistant:0:FIRST"]);
  });

  it("does not close ended streamed text again at idle", async () => {
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
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "sse_1", delta: "LIVE" },
    });
    await ingestOpenCodeEvent({
      type: "session.next.text.ended",
      properties: { sessionID: "ses_1", textID: "sse_1", text: "LIVE" },
    });
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "go" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ id: "persist_1", type: "text", text: "LIVE" }],
      },
    ]);
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "persist_1", type: "text", text: "LIVE" },
      },
    });
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await flush();
    const closes = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; key?: { channel?: string; providerItemId?: string }; item?: { text?: string } }> })
          ?.deltas ?? []
      )
        .filter((delta) => delta.kind === "item.close" || delta.kind === "item.textClose")
        .map((delta) => delta.key?.providerItemId ?? delta.key?.channel);
    });
    expect(closes).toEqual(["assistant:0"]);
  });

  it("closes a 3-message turn on streamed ids when only FIRST lacks ended", async () => {
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
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "sse_first", delta: "FIRST" },
    });
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "sse_mid", delta: "MIDDLE" },
    });
    await ingestOpenCodeEvent({
      type: "session.next.text.ended",
      properties: { sessionID: "ses_1", textID: "sse_mid", text: "MIDDLE" },
    });
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "sse_final", delta: "FINAL" },
    });
    await ingestOpenCodeEvent({
      type: "session.next.text.ended",
      properties: { sessionID: "ses_1", textID: "sse_final", text: "FINAL" },
    });
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "go" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ id: "persist_first", type: "text", text: "FIRST" }],
      },
      {
        info: { id: "a2", role: "assistant" },
        parts: [{ id: "persist_mid", type: "text", text: "MIDDLE" }],
      },
      {
        info: { id: "a3", role: "assistant" },
        parts: [{ id: "persist_final", type: "text", text: "FINAL" }],
      },
    ]);
    for (const [id, text] of [
      ["persist_first", "FIRST"],
      ["persist_mid", "MIDDLE"],
      ["persist_final", "FINAL"],
    ] as const) {
      await ingestOpenCodeEvent({
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: { id, type: "text", text },
        },
      });
    }
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await flush();
    const closes = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; text?: string; key?: { channel?: string; providerItemId?: string }; item?: { text?: string } }> })
          ?.deltas ?? []
      )
        .filter((delta) => delta.kind === "item.close" || delta.kind === "item.textClose")
        .map((delta) => `${delta.key?.providerItemId ?? delta.key?.channel}:${delta.item?.text ?? delta.text ?? ""}`);
    });
    expect(closes.filter((row) => row.includes("persist_"))).toEqual([]);
    expect(closes.filter((row) => row.startsWith("assistant:0:"))).toEqual([
      "assistant:0:FIRST",
    ]);
    expect(closes.filter((row) => row.startsWith("assistant:1:"))).toEqual([
      "assistant:1:MIDDLE",
    ]);
    expect(closes.filter((row) => row.startsWith("assistant:2:"))).toEqual([
      "assistant:2:FINAL",
    ]);
  });

  it("closes a streamed text bubble before the next item opens", async () => {
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
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "sse_first", delta: "FIRST" },
    });
    await ingestOpenCodeEvent({
      type: "session.next.tool.called",
      properties: {
        sessionID: "ses_1",
        callID: "call_1",
        tool: "read",
        input: { filePath: "package.json" },
      },
    });
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "sse_mid", delta: "MIDDLE" },
    });
    await flush();
    const timeline = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as {
          deltas?: Array<{ kind: string; key?: { channel?: string; providerItemId?: string }; item?: { text?: string } }>;
        })?.deltas ?? []
      ).map((delta) => `${delta.kind}:${delta.key?.providerItemId ?? delta.key?.channel ?? "item"}`);
    });
    const first = timeline.indexOf("item.close:assistant:0");
    const tool = timeline.findIndex(
      (row) => row.startsWith("item.open:") && !row.includes("assistant:"),
    );
    expect(first).toBeGreaterThanOrEqual(0);
    expect(tool).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(tool);
  });

  it("closes FIRST on its opened id when the tool starts first", async () => {
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
    await ingestOpenCodeEvent({
      type: "session.next.tool.called",
      properties: {
        sessionID: "ses_1",
        callID: "call_1",
        tool: "read",
        input: { filePath: "package.json" },
      },
    });
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "sse_first", delta: "FIRST" },
    });
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "go" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [
          { id: "persist_1", type: "text", text: "FIRST" },
          { id: "persist_2", type: "text", text: "MIDDLE" },
        ],
      },
    ]);
    await ingestOpenCodeEvent({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", textID: "sse_mid", delta: "MIDDLE" },
    });
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await flush();
    const closes = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (
          message.params as {
            deltas?: Array<{
              kind: string;
              key?: { providerItemId?: string };
              item?: { text?: string };
            }>;
          }
        )?.deltas ?? []
      )
        .filter(
          (delta) =>
            delta.kind === "item.close" &&
            String(delta.key?.providerItemId ?? "").startsWith("assistant:"),
        )
        .map((delta) => `${delta.key?.providerItemId}:${delta.item?.text ?? ""}`);
    });
    expect(closes.sort()).toEqual(["assistant:0:FIRST", "assistant:1:MIDDLE"]);
  });

  it("moves resumed chunked text to a fresh item after interleaving", async () => {
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

    const chunk = (textID: string, delta: string) =>
      ingestOpenCodeEvent({
        type: "session.next.text.delta",
        properties: { sessionID: "ses_1", textID, delta },
      });
    const foreign = (reasoningID: string) =>
      ingestOpenCodeEvent({
        type: "session.next.reasoning.delta",
        properties: { sessionID: "ses_1", reasoningID, delta: "thinking" },
      });

    // FIRST streams in chunks, a foreign item opens mid-stream, then FIRST resumes.
    await chunk("sse_first", "FIR");
    await chunk("sse_first", "S");
    await foreign("r1");
    await chunk("sse_first", "T");
    await chunk("sse_mid", "MIDDLE");
    await ingestOpenCodeEvent({
      type: "session.next.text.ended",
      properties: { sessionID: "ses_1", textID: "sse_mid", text: "MIDDLE" },
    });
    await flush();

    const timeline = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as {
          deltas?: Array<{ kind: string; text?: string; key?: { channel?: string } }>;
        })?.deltas ?? []
      ).map((delta) => {
        const key = delta.key as { providerItemId?: string; channel?: string };
        const id = key?.providerItemId ?? key?.channel ?? "?";
        return `${delta.kind}:${id}:${delta.text ?? ""}`;
      });
    });

    expect(timeline).toEqual([
      "item.open:assistant:0:",
      "item.textDelta:assistant:0:FIR",
      "item.textDelta:assistant:0:S",
      "item.close:assistant:0:",
      "item.textDelta:reasoning:r1:thinking",
      "item.open:assistant:1:",
      "item.textDelta:assistant:1:T",
      "item.close:assistant:1:",
      "item.open:assistant:2:",
      "item.textDelta:assistant:2:MIDDLE",
      "item.close:assistant:2:",
    ]);
  });

  it("does not remint prior-turn text on a follow-up poll", async () => {
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
        parts: [{ id: "t1", type: "text", text: "OLD_ANSWER" }],
      },
    ]);
    expect(await syncLiveTurnParts("ses_1")).toBe(true);
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await flush();
    send({
      id: "turn2",
      method: "turn/start",
      params: turnParams({
        clientRequestId: "req_2",
        input: [{ type: "text", text: "again", mentions: [] }],
      }),
    });
    await flush();
    messages.length = 0;
    expect(await syncLiveTurnParts("ses_1")).toBe(false);
    const stale = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; text?: string }> })
          ?.deltas ?? []
      )
        .filter((delta) => delta.kind === "item.textDelta")
        .map((delta) => delta.text);
    });
    expect(stale).not.toContain("OLD_ANSWER");
    fake.messages.set("ses_1", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "go" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [{ id: "t1", type: "text", text: "OLD_ANSWER" }],
      },
      {
        info: { id: "u2", role: "user" },
        parts: [{ type: "text", text: "again" }],
      },
      {
        info: { id: "a2", role: "assistant" },
        parts: [{ id: "t2", type: "text", text: "NEW_ANSWER" }],
      },
    ]);
    expect(await syncLiveTurnParts("ses_1")).toBe(true);
    const next = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string; text?: string }> })
          ?.deltas ?? []
      )
        .filter((delta) => delta.kind === "item.textDelta")
        .map((delta) => delta.text);
    });
    expect(next).toContain("NEW_ANSWER");
    expect(next).not.toContain("OLD_ANSWER");
  });

  it("still polls current-turn text if the last-user snapshot fails", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    const inner = fake.client.sessionMessages.bind(fake.client);
    let failSeed = true;
    fake.client.sessionMessages = async (id) => {
      if (failSeed) {
        failSeed = false;
        throw new Error("snapshot down");
      }
      return inner(id);
    };
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
  });

  it("keeps inherited variant when the last-user snapshot fails", async () => {
    const fake = installFake();
    fake.sessions.set("ses_1", { id: "ses_1", directory: "/tmp/a" });
    fake.messages.set("ses_1", [
      {
        info: {
          id: "u1",
          role: "user",
          agent: "explore",
          model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" },
        },
        parts: [{ type: "text", text: "explore" }],
      },
    ]);
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        options: {
          ...fullOptions,
          providerOptions: { adoptSessionId: "ses_1" },
        },
      }),
    });
    await flush();
    const inner = fake.client.sessionMessages.bind(fake.client);
    let failSeed = true;
    fake.client.sessionMessages = async (id) => {
      if (failSeed) {
        failSeed = false;
        throw new Error("snapshot down");
      }
      return inner(id);
    };
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "continue", mentions: [] }],
        options: {
          ...fullOptions,
          model: "xai/grok-4.6",
          reasoningLevel: "medium",
          providerOptions: { agent: "build" },
        },
      }),
    });
    await flush();
    expect(fake.lastPrompt?.body).toMatchObject({
      agent: "explore",
      variant: "high",
    });
  });

  it("recovers a title when OpenCode ensureTitle never lands", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    fake.messages.set("ses_1", [
      {
        info: { role: "user", agent: "build" },
        parts: [{ type: "text", text: "What's good" }],
      },
    ]);
    messages.length = 0;
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "What's good", mentions: [] }],
      }),
    });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fake.sessions.get("ses_1")?.title).toBe("Casual greeting");
    expect(fake.calls.update.some((call) => call.title === "Casual greeting")).toBe(
      true,
    );
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string; name?: string }> })
          ?.deltas;
        return deltas?.some(
          (delta) => delta.kind === "thread.name" && delta.name === "Casual greeting",
        );
      }),
    ).toBe(true);
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

  it("keeps live turns when the event stream drops but serve is healthy", async () => {
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
    ).toBe(false);
  });

  it("errors live turns when the event stream dies and serve is gone (ISC-26)", async () => {
    const fake = installFake();
    fake.healthy = false;
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

  it("auto-approves the next ask after a live stamp to full", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        options: {
          permissionMode: "auto",
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
      params: turnParams({
        options: {
          permissionMode: "auto",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
          providerOptions: { agent: "build" },
        },
      }),
    });
    await flush();
    writeLivePermissionMode("/tmp/bb-oc-bridge-test", "thr_1", "full");
    await ingestOpenCodeEvent({
      type: "permission.asked",
      properties: {
        id: "p-live-full",
        sessionID: "ses_1",
        permission: "bash",
        metadata: { command: "ls" },
      },
    });
    expect(fake.calls.reply).toEqual([
      { requestID: "p-live-full", reply: "once" },
    ]);
    expect(
      messages.some((message) => message.method === "interaction/request"),
    ).toBe(false);
  });

  it("shows a card on the next ask after a live stamp to accept-edits", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams(),
    });
    await flush();
    writeLivePermissionMode("/tmp/bb-oc-bridge-test", "thr_1", "accept-edits");
    await ingestOpenCodeEvent({
      type: "permission.asked",
      properties: {
        id: "p-live-card",
        sessionID: "ses_1",
        permission: "bash",
        metadata: { command: "ls" },
      },
    });
    expect(fake.calls.reply).toEqual([]);
    expect(
      messages.some((message) => message.method === "interaction/request"),
    ).toBe(true);
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

  it("opens the bash row before the Allow card and keeps later output on it", async () => {
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
        id: "p-row",
        sessionID: "ses_1",
        type: "bash",
        callID: "call_row",
        metadata: { command: "echo hi" },
      },
    });
    const deltasOf = (message: Record<string, unknown>) =>
      ((message.params as { deltas?: Array<Record<string, unknown>> } | undefined)
        ?.deltas ?? []);
    const openIndex = messages.findIndex(
      (message) =>
        message.method === "thread/delta" &&
        deltasOf(message).some(
          (delta) =>
            delta.kind === "item.open" &&
            (delta.key as { providerItemId?: string } | undefined)
              ?.providerItemId === "call_row",
        ),
    );
    const cardIndex = messages.findIndex(
      (message) => message.method === "interaction/request",
    );
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(cardIndex).toBeGreaterThan(openIndex);
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_row",
          sessionID: "ses_1",
          type: "tool",
          tool: "bash",
          callID: "call_row",
          state: {
            status: "completed",
            input: { command: "echo hi" },
            metadata: { output: "hi\n" },
          },
        },
      },
    });
    const commandOpens = messages.flatMap((message) =>
      message.method === "thread/delta"
        ? deltasOf(message).filter(
            (delta) =>
              delta.kind === "item.open" &&
              (delta.item as { type?: string } | undefined)?.type === "command",
          )
        : [],
    );
    expect(commandOpens).toHaveLength(1);
    expect(
      messages.some(
        (message) =>
          message.method === "thread/delta" &&
          deltasOf(message).some(
            (delta) =>
              delta.kind === "item.close" &&
              (delta.key as { providerItemId?: string } | undefined)
                ?.providerItemId === "call_row",
          ),
      ),
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

  it("cards a question tool part as native user_question", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({ id: "turn", method: "turn/start", params: turnParams() });
    await flush();
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: {
          id: "prt_q",
          type: "tool",
          tool: "question",
          state: {
            status: "running",
            input: {
              questions: [
                {
                  question: "Section name?",
                  options: [{ label: "A" }, { label: "B" }],
                },
              ],
            },
          },
        },
      },
    });
    const request = messages.find(
      (message) => message.method === "interaction/request",
    );
    expect(request).toMatchObject({
      id: "oc-q-prt_q",
      params: {
        payload: {
          kind: "user_question",
          questions: [{ id: "prt_q:q1", prompt: "Section name?" }],
        },
      },
    });
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind?: string; tool?: string }> })
          ?.deltas;
        return deltas?.some((delta) => delta.tool === "question");
      }),
    ).toBe(false);
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
    expect(fake.calls.promptAsync).toBe(1);
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
      false,
    );
    expect(String(fake.lastPrompt?.body.system ?? "")).toContain("bb-cli: Use bb");
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

  it("does not reject an unmappable ask that still has an id", async () => {
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
      properties: { id: "p-bad", sessionID: "ses_1" },
    });
    expect(fake.calls.reply).toEqual([]);
  });

  it("waits for the bash command instead of rejecting an empty ask", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    const accept = {
      permissionMode: "accept-edits",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    };
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({ options: accept }),
    });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        options: { ...accept, providerOptions: { agent: "build" } },
      }),
    });
    await flush();
    await ingestOpenCodeEvent({
      type: "permission.asked",
      properties: { id: "p-wait", sessionID: "ses_1", permission: "bash" },
    });
    expect(fake.calls.reply).toEqual([]);
    expect(
      messages.some((message) => message.method === "interaction/request"),
    ).toBe(false);
    await ingestOpenCodeEvent({
      type: "permission.updated",
      properties: {
        id: "p-wait",
        sessionID: "ses_1",
        type: "bash",
        callID: "call_wait",
        metadata: { command: "echo SMOKE" },
      },
    });
    expect(fake.calls.reply).toEqual([]);
    expect(
      messages.some((message) => message.method === "interaction/request"),
    ).toBe(true);
  });

  it("does not reject a dropped foreign permission ask", async () => {
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
    await ingestOpenCodeEvent({
      type: "permission.asked",
      properties: {
        id: "p-foreign",
        sessionID: "ses_other",
        permission: "bash",
        metadata: { command: "ls" },
      },
    });
    expect(fake.calls.reply).toEqual([]);
  });

  it("does not settle a live turn while a permission card is open", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    const accept = {
      permissionMode: "accept-edits",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    };
    send({ id: "start", method: "thread/start", params: sessionParams({ options: accept }) });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        options: { ...accept, providerOptions: { agent: "build" } },
      }),
    });
    await flush();
    const ask = {
      id: "p-card",
      sessionID: "ses_1",
      permission: "bash",
      metadata: { command: "echo SMOKE" },
    };
    fake.pendingPermissions = [ask];
    await ingestOpenCodeEvent({
      type: "permission.asked",
      properties: ask,
    });
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await flush();
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string }> })?.deltas;
        return deltas?.some((delta) => delta.kind === "turn.boundary");
      }),
    ).toBe(false);
  });

  it("settles when OpenCode idles after a ghost permission card", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    const accept = {
      permissionMode: "accept-edits",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    };
    send({ id: "start", method: "thread/start", params: sessionParams({ options: accept }) });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        options: { ...accept, providerOptions: { agent: "build" } },
      }),
    });
    await flush();
    await ingestOpenCodeEvent({
      type: "permission.asked",
      properties: {
        id: "p-ghost",
        sessionID: "ses_1",
        permission: "bash",
        metadata: { command: "echo SMOKE" },
      },
    });
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await flush();
    expect(
      messages.some((message) => {
        const deltas = (message.params as { deltas?: Array<{ kind: string }> })?.deltas;
        return deltas?.some((delta) => delta.kind === "turn.boundary");
      }),
    ).toBe(true);
    expect(fake.calls.reply).toEqual([]);
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

  it("bind-only adopt hydrates without prompting", async () => {
    const fake = installFake();
    fake.sessions.set("child", { id: "child", directory: "/tmp/a" });
    fake.messages.set("child", [
      {
        info: { id: "m1", role: "user" },
        parts: [{ type: "text", text: "explore" }],
      },
    ]);
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        input: [{ type: "text", text: "seed", mentions: [] }],
        options: {
          ...fullOptions,
          providerOptions: { adoptSessionId: "child", bindOnly: true },
        },
      }),
    });
    await flush();
    expect(fake.calls.create).toBe(0);
    expect(fake.calls.prompt).toBe(0);
    const kinds = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string }> })?.deltas ?? []
      ).map((delta) => delta.kind);
    });
    expect(kinds).toContain("turn.open");
    expect(fake.calls.prompt).toBe(0);
  });

  it("bind-only running child stays open until idle", async () => {
    const fake = installFake();
    fake.sessions.set("child", { id: "child", directory: "/tmp/a" });
    fake.messages.set("child", []);
    fake.runningIds.add("child");
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        threadId: "thr_child",
        input: [{ type: "text", text: "seed", mentions: [] }],
        options: {
          ...fullOptions,
          providerOptions: { adoptSessionId: "child", bindOnly: true },
        },
      }),
    });
    await flush();
    expect(fake.calls.prompt).toBe(0);
    const beforeIdle = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string }> })?.deltas ?? []
      ).map((delta) => delta.kind);
    });
    expect(beforeIdle).toContain("turn.open");
    expect(beforeIdle).not.toContain("turn.boundary");
    await ingestOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "child" },
    });
    const afterIdle = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string }> })?.deltas ?? []
      ).map((delta) => delta.kind);
    });
    expect(afterIdle).toContain("turn.boundary");
  });

  it("bind-only does not close on the first completed assistant step", async () => {
    const fake = installFake();
    fake.runningIds.add("child");
    fake.sessions.set("child", { id: "child", directory: "/tmp/a" });
    fake.messages.set("child", [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "explore" }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [
          {
            id: "t1",
            type: "text",
            text: "GOAL",
            state: { status: "completed" },
          },
          {
            id: "tool1",
            type: "tool",
            tool: "read",
            state: { status: "completed", input: { filePath: "a.ts" } },
          },
        ],
      },
    ]);
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        threadId: "thr_child",
        input: [{ type: "text", text: "seed", mentions: [] }],
        options: {
          ...fullOptions,
          providerOptions: { adoptSessionId: "child", bindOnly: true },
        },
      }),
    });
    await flush();
    const kinds = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string }> })?.deltas ?? []
      ).map((delta) => delta.kind);
    });
    expect(kinds).toContain("item.textDelta");
    expect(kinds.filter((kind) => kind === "turn.boundary")).toEqual([]);
  });

  it("bind-only does not re-prompt a running subagent with the parent agent", async () => {
    const fake = installFake();
    fake.runningIds.add("child");
    fake.sessions.set("child", { id: "child", directory: "/tmp/a" });
    fake.messages.set("child", [
      {
        info: {
          id: "u1",
          role: "user",
          agent: "explore",
          model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" },
        },
        parts: [{ type: "text", text: "explore" }],
      },
    ]);
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        threadId: "thr_child",
        input: [{ type: "text", text: TASK_CHILD_BIND_TEXT, mentions: [] }],
        options: {
          ...fullOptions,
          model: "xai/grok-4.6",
          reasoningLevel: "medium",
          providerOptions: { adoptSessionId: "child", bindOnly: true, agent: "build" },
        },
      }),
    });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        threadId: "thr_child",
        providerThreadId: "child",
        input: [{ type: "text", text: TASK_CHILD_BIND_TEXT, mentions: [] }],
        options: {
          ...fullOptions,
          model: "xai/grok-4.6",
          reasoningLevel: "medium",
          providerOptions: { agent: "build" },
        },
      }),
    });
    await flush();
    expect(fake.calls.prompt).toBe(0);
    expect(fake.calls.promptAsync).toBe(0);
  });

  it("follow-up on a subagent child keeps that agent's model", async () => {
    const fake = installFake();
    fake.sessions.set("ses_1", { id: "ses_1", directory: "/tmp/a" });
    fake.messages.set("ses_1", [
      {
        info: {
          id: "u1",
          role: "user",
          agent: "explore",
          model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" },
        },
        parts: [{ type: "text", text: "explore" }],
      },
    ]);
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        options: {
          ...fullOptions,
          providerOptions: { adoptSessionId: "ses_1" },
        },
      }),
    });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "continue", mentions: [] }],
        options: {
          ...fullOptions,
          model: "xai/grok-4.6",
          reasoningLevel: "medium",
          providerOptions: { agent: "build" },
        },
      }),
    });
    await flush();
    expect(fake.lastPrompt?.body).toMatchObject({
      agent: "explore",
      model: { providerID: "openai", modelID: "gpt-5.6-luna" },
      variant: "high",
    });
  });

  function deltaKinds(): string[] {
    return messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<{ kind: string }> })?.deltas ?? []
      ).map((delta) => delta.kind);
    });
  }

  it("opens then fails the first turn if prompt setup dies after identity", async () => {
    const fake = installFake();
    fake.client.agents = async () => {
      throw new Error("agents down");
    };
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        input: [{ type: "text", text: "write scratch/isc33-probe.txt", mentions: [] }],
        options: { ...fullOptions, providerOptions: { agent: "build" } },
      }),
    });
    await flush();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "start",
          result: expect.objectContaining({ providerThreadId: "ses_1" }),
        }),
      ]),
    );
    expect(deltaKinds()).toEqual(
      expect.arrayContaining(["session.reset", "turn.open", "turn.boundary"]),
    );
    const failed = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []
      );
    }).find((delta) => delta.kind === "turn.boundary");
    expect(failed).toMatchObject({
      kind: "turn.boundary",
      status: "failed",
      error: { message: "agents down" },
    });
    expect(fake.calls.prompt).toBe(0);
  });

  it("pins BB bare model ids as provider/model on the first prompt", async () => {
    const fake = installFake();
    fake.client.providers = async () => ({
      providers: [{ id: "openai", models: { "gpt-5.6-luna": {} } }],
    });
    send({
      id: "start",
      method: "thread/start",
      params: sessionParams({
        input: [{ type: "text", text: "write scratch/isc33-probe.txt", mentions: [] }],
        options: {
          ...fullOptions,
          model: "gpt-5.6-luna",
          providerOptions: { agent: "build" },
        },
      }),
    });
    await flush();
    expect(fake.lastPrompt?.body).toMatchObject({
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6-luna" },
    });
    const failed = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []
      );
    }).find(
      (delta) => delta.kind === "turn.boundary" && delta.status === "failed",
    );
    expect(failed).toBeUndefined();
  });

  it("routes standalone /compact through session.summarize (ISC-92)", async () => {
    const fake = installFake();
    fake.commands.push({ name: "compact" });
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [
          {
            type: "text",
            text: "/compact",
            mentions: [
              {
                start: 0,
                end: 8,
                resource: {
                  kind: "command",
                  name: "compact",
                  origin: "builtin",
                },
              },
            ],
          },
        ],
      }),
    });
    await flush();
    expect(fake.calls.prompt).toBe(0);
    expect(fake.calls.command).toEqual([]);
    expect(fake.calls.summarize).toEqual([
      {
        id: "ses_1",
        body: { providerID: "opencode", modelID: "gpt-4.1" },
      },
    ]);
    expect(deltaKinds()).toEqual(
      expect.arrayContaining([
        "turn.open",
        "item.open",
        "item.close",
        "context.compacted",
        "turn.boundary",
        "session.reset",
      ]),
    );
  });

  it("does not summarize again when OpenCode auto-compacts (ISC-92)", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    const before = fake.calls.summarize.length;
    await ingestOpenCodeEvent({
      type: "session.compacted",
      properties: { sessionID: "ses_1" },
    });
    expect(fake.calls.summarize.length).toBe(before);
    expect(deltaKinds()).toContain("context.compacted");
  });

  it("maps todo.updated onto native planSteps (ISC-93)", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    await ingestOpenCodeEvent({
      type: "todo.updated",
      properties: {
        sessionID: "ses_1",
        todos: [{ id: "t1", content: "Ship compact", status: "in_progress" }],
      },
    });
    const plan = messages.flatMap((message) => {
      if (message.method !== "thread/delta") return [];
      return (
        (message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []
      );
    }).find((delta) => delta.kind === "item.close");
    expect(plan).toMatchObject({
      kind: "item.close",
      key: { channel: "planSteps" },
      item: {
        type: "planSteps",
        steps: [{ step: "Ship compact", status: "active" }],
      },
    });
    expect(fake.todos.size).toBe(0);
  });

  it("restores files on Edit commit, not on user Fork or rewind prepare", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    fake.messages.set("ses_1", [
      { info: { id: "keep" }, parts: [] },
      { info: { id: "drop" }, parts: [] },
    ]);
    send({
      id: "user-fork",
      method: "thread/fork",
      params: sessionParams({
        threadId: "thr_user_fork",
        sourceProviderThreadId: "ses_1",
        sourceProviderCheckpointId: "keep",
      }),
    });
    await flush();
    expect(fake.calls.revert).toBe(0);
    send({
      id: "prepare",
      method: "thread/fork",
      params: sessionParams({
        threadId: "thr_1:rewind:lease",
        sourceProviderThreadId: "ses_1",
        sourceProviderCheckpointId: "keep",
      }),
    });
    await flush();
    expect(fake.calls.revert).toBe(0);
    send({
      id: "commit",
      method: "thread/start",
      params: sessionParams({
        threadId: "thr_edit",
        input: [{ type: "text", text: "seed", mentions: [] }],
        options: {
          ...fullOptions,
          providerOptions: {
            agent: "build",
            adoptSessionId: "ses_fork_2",
            bindOnly: true,
          },
        },
      }),
    });
    await flush();
    expect(fake.calls.revert).toBe(0);
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        threadId: "thr_edit",
        providerThreadId: "ses_fork_2",
        input: [{ type: "text", text: "rewrite", mentions: [] }],
      }),
    });
    await flush();
    expect(fake.calls.revert).toBe(1);
    expect(fake.lastRevert).toEqual({
      id: "ses_1",
      body: { messageID: "drop" },
    });
  });

  it("subscribes to the bound project directory", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    expect(fake.lastSubscribeDirectory).toBe("/tmp/a");
  });

  it("aborts a running write with no permission card after a short poll", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams(),
    });
    await flush();
    fake.messages.set("ses_1", [
      {
        info: { role: "user", id: "u1" },
        parts: [{ type: "text", text: "write" }],
      },
      {
        info: { role: "assistant", id: "a1" },
        parts: [
          {
            type: "tool",
            tool: "apply_patch",
            state: {
              status: "running",
              input: { patchText: "*** Begin Patch\n*** Update File: a.ts\n" },
            },
          },
        ],
      },
    ]);
    await syncLiveTurnParts("ses_1");
    await syncLiveTurnParts("ses_1");
    await syncLiveTurnParts("ses_1");
    expect(fake.calls.abort).toBe(1);
    expect(JSON.stringify(messages)).toContain(
      "OpenCode write is waiting without a permission card",
    );
  });

  it("warns once on OpenCode retry and keeps the turn open", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "go", mentions: [] }],
      }),
    });
    await flush();
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited" },
      },
    });
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "retry",
          sessionID: "ses_1",
          attempt: 2,
          error: { name: "APIError", data: { message: "rate limited" } },
        },
      },
    });
    const deltas = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []),
    );
    const warnings = deltas.filter((delta) => delta.kind === "provider.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      summary: "OpenCode attempt 2",
      details: "rate limited",
    });
    expect(deltas.some((delta) => delta.kind === "turn.boundary")).toBe(false);
  });

  it("fails a session.error with the real message and flushes text", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "go", mentions: [] }],
      }),
    });
    await flush();
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "t1", type: "text", sessionID: "ses_1", text: "partial" },
      },
    });
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "session.error",
      properties: {
        sessionID: "ses_1",
        error: { name: "APIError", data: { message: "provider 503" } },
      },
    });
    const deltas = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []),
    );
    expect(deltas).toContainEqual(
      expect.objectContaining({
        kind: "item.close",
        item: { type: "agentMessage", text: "partial" },
      }),
    );
    expect(deltas).toContainEqual(
      expect.objectContaining({
        kind: "turn.boundary",
        status: "failed",
        error: { message: "provider 503" },
      }),
    );
  });

  it("treats MessageAbortedError as interrupted, not failed", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "go", mentions: [] }],
      }),
    });
    await flush();
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "session.error",
      properties: {
        sessionID: "ses_1",
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
      },
    });
    const deltas = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []),
    );
    expect(deltas).toContainEqual(
      expect.objectContaining({
        kind: "turn.boundary",
        status: "interrupted",
      }),
    );
    expect(
      deltas.some(
        (delta) => delta.kind === "turn.boundary" && delta.status === "failed",
      ),
    ).toBe(false);
  });

  it("does not retire a child Task on busy status", async () => {
    const fake = installFake();
    fake.promptImpl = () => new Promise(() => undefined);
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "turn",
      method: "turn/start",
      params: turnParams({
        input: [{ type: "text", text: "go", mentions: [] }],
      }),
    });
    await flush();
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "task-1",
          type: "tool",
          tool: "task",
          sessionID: "ses_1",
          state: {
            status: "running",
            title: "Task",
            input: { description: "Explore" },
            metadata: { sessionID: "ses_child" },
          },
        },
      },
    });
    messages.length = 0;
    await ingestOpenCodeEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_child",
        parentID: "ses_1",
        status: { type: "busy" },
      },
    });
    await ingestOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        parentID: "ses_1",
        sessionID: "ses_child",
        part: {
          id: "read-1",
          type: "tool",
          tool: "read",
          state: { status: "running", input: { filePath: "README.md" } },
        },
      },
    });
    const deltas = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []),
    );
    expect(deltas.some((delta) => delta.kind === "turn.boundary")).toBe(false);
    expect(deltas).toContainEqual(
      expect.objectContaining({
        kind: "item.open",
        item: expect.objectContaining({ type: "fileRead", path: "README.md" }),
      }),
    );
  });

  it("writes a user rename onto the OpenCode session", async () => {
    const fake = installFake();
    send({ id: "start", method: "thread/start", params: sessionParams() });
    await flush();
    send({
      id: "rename",
      method: "thread/name/set",
      params: {
        threadId: "thr_1",
        providerThreadId: "ses_1",
        title: "My probe",
      },
    });
    await flush();
    expect(messages.find((message) => message.id === "rename")).toMatchObject({
      result: {},
    });
    expect(fake.calls.update).toContainEqual({ id: "ses_1", title: "My probe" });
    fake.sessions.get("ses_1")!.title = "Create scratch/isc33-probe.txt";
    expect(await syncSessionTitle("ses_1")).toBe(false);
    expect(fake.sessions.get("ses_1")?.title).toBe("Create scratch/isc33-probe.txt");
  });

  it("answers provider/usage without inventing a quota", async () => {
    installFake();
    send({ id: "usage", method: "provider/usage", params: {} });
    await flush();
    expect(messages.find((message) => message.id === "usage")).toMatchObject({
      result: {
        supported: true,
        usage: {
          status: "error",
          planLabel: "OpenCode",
        },
      },
    });
  });
});
