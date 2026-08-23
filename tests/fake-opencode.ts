import type { OpenCodeClient, OpenCodeSession } from "../src/client.js";

export interface FakeOpenCode {
  client: OpenCodeClient;
  calls: {
    create: number;
    prompt: number;
    promptAsync: number;
    abort: number;
    revert: number;
    unrevert: number;
    reply: Array<{ requestID: string; reply: string }>;
    questionReply: Array<{ requestID: string; answers?: string[][] }>;
    questionReject: string[];
    command: Array<{ id: string; body: Record<string, unknown> }>;
    get: number;
    messages: number;
    fork: Array<{ id: string; body: Record<string, unknown> }>;
    summarize: Array<{ id: string; body: Record<string, unknown> }>;
  };
  runningIds: Set<string>;
  todos: Map<string, unknown[]>;
  commands: Array<{ name: string; description?: string }>;
  sessions: Map<string, OpenCodeSession>;
  messages: Map<
    string,
    Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  >;
  agents: Array<{
    name: string;
    mode?: string;
    hidden?: boolean;
    description?: string;
  }>;
  emit: (event: { type: string; properties?: unknown }) => void;
  promptImpl?: (id: string, body: Record<string, unknown>) => Promise<unknown>;
  lastPrompt?: { id: string; body: Record<string, unknown> };
}

export function createFakeOpenCode(): FakeOpenCode {
  let handler: ((event: { type: string; properties?: unknown }) => void) | undefined;
  const fake: FakeOpenCode = {
    calls: {
      create: 0,
      prompt: 0,
      promptAsync: 0,
      abort: 0,
      revert: 0,
      unrevert: 0,
      reply: [],
      questionReply: [],
      questionReject: [],
      command: [],
      get: 0,
      messages: 0,
      fork: [],
      summarize: [],
    },
    runningIds: new Set(),
    todos: new Map(),
    commands: [{ name: "init", description: "guided AGENTS.md setup" }],
    sessions: new Map(),
    messages: new Map(),
    agents: [
      { name: "build", mode: "primary" },
      { name: "plan", mode: "primary" },
      { name: "custom", mode: "primary" },
      { name: "compaction", mode: "primary", hidden: true },
      { name: "title", mode: "primary", hidden: true },
      { name: "explore", mode: "subagent" },
    ],
    emit(event) {
      handler?.(event);
    },
    lastPrompt: undefined,
    client: {
      url: "http://127.0.0.1:9",
      async health() {
        return { healthy: true, version: "1.18.21" };
      },
      async createSession(args) {
        fake.calls.create += 1;
        const id = `ses_${fake.calls.create}`;
        const session: OpenCodeSession = {
          id,
          directory: args.directory,
          title: args.title ?? `New session - ${new Date().toISOString()}`,
          parentID: args.parentID,
        };
        fake.sessions.set(id, session);
        fake.messages.set(id, []);
        return session;
      },
      async getSession(id) {
        fake.calls.get += 1;
        const session = fake.sessions.get(id);
        if (!session) throw new Error(`missing session ${id}`);
        return session;
      },
      async listSessions() {
        return [...fake.sessions.values()];
      },
      async sessionChildren(id) {
        return [...fake.sessions.values()].filter((session) => session.parentID === id);
      },
      async sessionMessages(id) {
        fake.calls.messages += 1;
        return fake.messages.get(id) ?? [];
      },
      async promptAsync(id, body) {
        fake.calls.promptAsync += 1;
        fake.lastPrompt = { id, body };
        return;
      },
      async prompt(id, body) {
        fake.calls.prompt += 1;
        fake.lastPrompt = { id, body };
        if (fake.promptImpl) return fake.promptImpl(id, body);
        queueMicrotask(() => {
          fake.emit({ type: "session.idle", properties: { sessionID: id } });
        });
        return {};
      },
      async abort() {
        fake.calls.abort += 1;
      },
      async revert() {
        fake.calls.revert += 1;
        return {};
      },
      async unrevert() {
        fake.calls.unrevert += 1;
        return {};
      },
      async forkSession(id, body) {
        fake.calls.fork.push({ id, body: body ?? {} });
        const forked = {
          id: `ses_fork_${fake.calls.fork.length}`,
          directory: fake.sessions.get(id)?.directory,
          title: fake.sessions.get(id)?.title,
        };
        fake.sessions.set(forked.id, forked);
        fake.messages.set(forked.id, [
          ...(fake.messages.get(id) ?? []),
        ]);
        return forked;
      },
      async agents() {
        return fake.agents;
      },
      async getConfig() {
        return { model: "opencode/gpt-4.1" };
      },
      async providers() {
        return {
          providers: [
            {
              id: "opencode",
              models: {
                "gpt-4.1": { limit: { context: 1_047_576 } },
                "claude-sonnet-4": { limit: { context: 200_000 } },
              },
            },
          ],
        };
      },
      async listCommands() {
        return fake.commands;
      },
      async sessionCommand(id, body) {
        fake.calls.command.push({ id, body });
        return {};
      },
      async replyQuestion({ requestID, answers }) {
        fake.calls.questionReply.push({ requestID, answers });
      },
      async rejectQuestion({ requestID }) {
        fake.calls.questionReject.push(requestID);
      },
      async listPendingQuestions() {
        return [];
      },
      async replyPermission({ requestID, reply }) {
        fake.calls.reply.push({ requestID, reply });
      },
      async listPendingPermissions() {
        return [];
      },
      async sessionTodos(id) {
        return fake.todos.get(id) ?? [];
      },
      async sessionIsRunning(id) {
        return fake.runningIds.has(id);
      },
      async summarize(id, body) {
        fake.calls.summarize.push({ id, body });
        return true;
      },
      async subscribe(next) {
        handler = next;
        return {
          unsubscribe() {
            handler = undefined;
          },
        };
      },
    },
  };
  return fake;
}
