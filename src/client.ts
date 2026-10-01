import { OpenCode } from "@opencode/client";
import { debugLog } from "./debug-log.js";
import {
  createV2EventState,
  translateV2Event,
  v1Messages,
  v1PermissionAsk,
  v1QuestionAsk,
  v1Session,
} from "./v2-map.js";

export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
}

export interface OpenCodeSession {
  id: string;
  title?: string;
  directory?: string;
  parentID?: string;
  projectID?: string;
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  time?: { created?: number; updated?: number };
  revert?: unknown;
}

export interface OpenCodeAgentInfo {
  name: string;
  mode?: string;
  hidden?: boolean;
  native?: boolean;
  description?: string;
}

export interface OpenCodeClient {
  url: string;
  health(): Promise<OpenCodeHealth>;
  createSession(args: {
    directory?: string;
    title?: string;
    parentID?: string;
  }): Promise<OpenCodeSession>;
  getSession(id: string): Promise<OpenCodeSession>;
  updateSession(id: string, body: { title: string }): Promise<OpenCodeSession>;
  listSessions(): Promise<OpenCodeSession[]>;
  sessionChildren(id: string, directory?: string): Promise<OpenCodeSession[]>;
  sessionMessages(id: string, limit?: number, before?: string): Promise<
    Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  >;
  prompt(
    id: string,
    body: Record<string, unknown>,
    directory?: string,
  ): Promise<unknown>;
  promptAsync(
    id: string,
    body: Record<string, unknown>,
    directory?: string,
  ): Promise<void>;
  abort(id: string, directory?: string): Promise<void>;
  revert(id: string, body: Record<string, unknown>): Promise<unknown>;
  unrevert(id: string): Promise<unknown>;
  revertCommit(id: string): Promise<void>;
  forkSession(
    id: string,
    body?: { messageID?: string },
  ): Promise<OpenCodeSession>;
  agents(directory?: string): Promise<OpenCodeAgentInfo[]>;
  providers(
    directory?: string,
  ): Promise<{ providers: Array<{ id: string; models?: unknown }> }>;
  listCommands(directory?: string): Promise<Array<{ name: string; description?: string }>>;
  sessionCommand(
    id: string,
    body: {
      command: string;
      arguments?: string;
      agent?: string;
      model?: string;
      variant?: string;
    },
    directory?: string,
  ): Promise<unknown>;
  getConfig(directory?: string): Promise<unknown>;
  replyPermission(args: {
    requestID: string;
    sessionID: string;
    reply: "once" | "always" | "reject";
    directory?: string;
  }): Promise<void>;
  listPendingPermissions(
    sessionID?: string,
    directory?: string,
  ): Promise<unknown[]>;
  replyQuestion(args: {
    requestID: string;
    sessionID: string;
    answers?: string[][];
    directory?: string;
  }): Promise<void>;
  rejectQuestion(args: {
    requestID: string;
    sessionID: string;
    directory?: string;
  }): Promise<void>;
  listPendingQuestions(sessionID: string, directory?: string): Promise<unknown[]>;
  sessionIsRunning(id: string, directory?: string): Promise<boolean>;
  sessionTodos(id: string): Promise<unknown[]>;
  summarize(
    id: string,
    body: { providerID: string; modelID: string },
  ): Promise<boolean>;
  subscribe(
    handler: (event: { type: string; properties?: unknown }) => void,
    directory?: string,
  ): Promise<{ unsubscribe(): void }>;
}

export function directoryQuery(directory?: string): string {
  if (!directory) return "";
  return `?directory=${encodeURIComponent(directory)}`;
}

export const OPENCODE_SETUP_MS = 8_000;
export const OPENCODE_REPLY_MS = 8_000;
export const OPENCODE_PROMPT_MS = 30_000;
const MODEL_CATALOG_WARMUP_RETRY_MS = 150;
/** V2 rejects `limit` above 200 on message lists. */
const MESSAGE_PAGE_MAX = 200;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Service auth headers per base URL, recorded by process attach. */
const endpointHeaders = new Map<string, Record<string, string>>();

export function rememberEndpointHeaders(
  url: string,
  headers: Record<string, string> | undefined,
): void {
  if (headers) endpointHeaders.set(url, headers);
  else endpointHeaders.delete(url);
}

export function endpointHeadersFor(url: string): Record<string, string> | undefined {
  return endpointHeaders.get(url);
}

type Sdk = ReturnType<typeof OpenCode.make>;
type Rec = Record<string, unknown>;

function location(directory?: string) {
  return directory ? { location: { directory } } : {};
}

function splitModel(ref: string): { providerID: string; id: string } | undefined {
  const index = ref.indexOf("/");
  if (index <= 0) return undefined;
  return { providerID: ref.slice(0, index), id: ref.slice(index + 1) };
}

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      const p = part as Rec;
      return p?.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function filesOf(parts: unknown): Array<{ uri: string; name?: string }> {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    const p = part as Rec;
    if (p?.type !== "file" || typeof p.url !== "string") return [];
    return [{ uri: p.url, ...(typeof p.filename === "string" ? { name: p.filename } : {}) }];
  });
}

/** Opaque V2 message cursor for "older than <id>" (matches the server's encoding). */
function beforeCursor(id: string): string {
  return Buffer.from(
    JSON.stringify({ id, order: "desc", direction: "next" }),
  ).toString("base64url");
}

function wrap(url: string, sdk: Sdk): OpenCodeClient {
  /** Last agent/model/instructions applied per session, so prompts only switch on change. */
  const applied = new Map<string, { agent?: string; model?: string; system?: string }>();
  const questionFields = new Map<string, Array<{ key: string; type: string }>>();
  let variantCache: { at: number; byModel: Map<string, string[]> } | undefined;

  async function modelVariants(ref: string): Promise<string[]> {
    if (!variantCache || Date.now() - variantCache.at > 60_000) {
      const result = (await sdk.model.list()) as unknown as { data?: Rec[] };
      const byModel = new Map<string, string[]>();
      for (const model of result.data ?? []) {
        const variants = Array.isArray(model.variants)
          ? model.variants.map((v) => String((v as Rec).id))
          : [];
        byModel.set(`${model.providerID}/${model.id}`, variants);
      }
      variantCache = { at: Date.now(), byModel };
    }
    return variantCache.byModel.get(ref) ?? [];
  }

  async function applySessionSettings(
    sessionID: string,
    body: Rec,
  ): Promise<void> {
    let seen = applied.get(sessionID);
    if (!seen) {
      const info = (await sdk.session.get({ sessionID })) as unknown as Rec;
      const model = info.model as Rec | undefined;
      seen = {
        agent: typeof info.agent === "string" ? info.agent : undefined,
        model: model
          ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
          : undefined,
      };
      applied.set(sessionID, seen);
    }
    const agent = typeof body.agent === "string" ? body.agent : undefined;
    if (agent && agent !== seen.agent) {
      await sdk.session.switchAgent({ sessionID, agent });
      seen.agent = agent;
    }
    const modelBody = body.model as Rec | string | undefined;
    const ref =
      typeof modelBody === "string"
        ? splitModel(modelBody)
        : modelBody && typeof modelBody.providerID === "string" && typeof modelBody.modelID === "string"
          ? { providerID: modelBody.providerID, id: modelBody.modelID }
          : undefined;
    if (ref) {
      const requested = typeof body.variant === "string" ? body.variant : undefined;
      // BB's reasoning level may name a variant this model lacks; V2 accepts the
      // switch but fails the run, so drop unknown variants up front (V1 did too).
      const variant =
        requested && (await modelVariants(`${ref.providerID}/${ref.id}`)).includes(requested)
          ? requested
          : undefined;
      const key = `${ref.providerID}/${ref.id}${variant ? `#${variant}` : ""}`;
      if (key !== seen.model) {
        await sdk.session.switchModel({
          sessionID,
          model: { ...ref, ...(variant ? { variant } : {}) },
        });
        seen.model = key;
      }
    }
    const system = typeof body.system === "string" ? body.system : undefined;
    if (system !== undefined && system !== seen.system) {
      await sdk.session.instructions.entry.put({ sessionID, key: "bb", value: system });
      seen.system = system;
    }
  }

  async function send(id: string, body: Rec, delivery?: "steer" | "queue"): Promise<void> {
    await applySessionSettings(id, body);
    const messageID = typeof body.messageID === "string" ? body.messageID : undefined;
    const files = filesOf(body.parts);
    await sdk.session.prompt({
      sessionID: id,
      ...(messageID ? { id: messageID } : {}),
      text: textOf(body.parts),
      ...(files.length > 0 ? { files } : {}),
      ...(delivery ? { delivery } : {}),
    } as never);
  }

  // V2 `compact` returns once queued; V1 callers expect it to return when done.
  const compactWaiters = new Map<string, (error?: string) => void>();
  function settleCompaction(event: Rec): void {
    if (event.type !== "session.compaction.ended" && event.type !== "session.compaction.failed") return;
    const data = (event.data ?? {}) as Rec;
    const waiter = compactWaiters.get(String(data.sessionID));
    if (!waiter) return;
    compactWaiters.delete(String(data.sessionID));
    waiter(event.type === "session.compaction.failed" ? String((data.error as Rec)?.message ?? data.error ?? "Compaction failed") : undefined);
  }

  // One V2 event stream per client, fanned out to every distinct handler.
  const handlers = new Map<(event: { type: string; properties?: unknown }) => void, number>();
  let stream: AbortController | undefined;
  function startStream(): void {
    if (stream) return;
    const controller = new AbortController();
    stream = controller;
    const state = createV2EventState();
    const emit = (event: { type: string; properties?: unknown }) => {
      for (const handler of [...handlers.keys()]) {
        try {
          handler(event);
        } catch {
          /* handler errors are the bridge's */
        }
      }
    };
    void (async () => {
      try {
        for await (const event of sdk.event.subscribe({ signal: controller.signal } as never)) {
          settleCompaction(event as unknown as Rec);
          for (const translated of translateV2Event(state, event)) emit(translated);
        }
        if (!controller.signal.aborted) emit({ type: "server.disconnected" });
      } catch (error) {
        if (!controller.signal.aborted) {
          debugLog(`sse error ${String(error)}`);
          emit({ type: "server.disconnected" });
        }
      } finally {
        if (stream === controller) stream = undefined;
      }
    })();
  }

  return {
    url,
    async health() {
      try {
        const info = (await withTimeout(sdk.server.info(), 5_000, "health")) as unknown as Rec;
        return { healthy: true, version: String(info.version ?? "") };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`OpenCode service did not answer health (${detail})`);
      }
    },
    async createSession(args) {
      const created = await withTimeout(
        sdk.session.create({
          ...(args.title ? { title: args.title } : {}),
          ...(args.directory ? { location: { directory: args.directory } } : {}),
        } as never),
        OPENCODE_SETUP_MS,
        "session.create",
      );
      return v1Session(created);
    },
    async getSession(id) {
      return v1Session(
        await withTimeout(sdk.session.get({ sessionID: id }), OPENCODE_SETUP_MS, "session.get"),
      );
    },
    async updateSession(id, body) {
      await sdk.session.update({ sessionID: id, title: body.title } as never);
      return v1Session(await sdk.session.get({ sessionID: id }));
    },
    async listSessions() {
      const result = (await withTimeout(
        sdk.session.list({ limit: 200, order: "desc", parentID: null } as never),
        OPENCODE_SETUP_MS,
        "session.list",
      )) as unknown as { data?: unknown[] };
      return (result.data ?? []).map(v1Session);
    },
    async sessionChildren(id) {
      const children: unknown[] = [];
      let cursor: string | undefined;
      while (true) {
        const result = (await sdk.session.list({
          parentID: id,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        } as never)) as unknown as { data?: unknown[]; cursor?: { next?: string | null } };
        const page = result.data ?? [];
        children.push(...page);
        if (page.length === 0 || !result.cursor?.next) break;
        cursor = result.cursor.next;
      }
      return children.map(v1Session);
    },
    async sessionMessages(id, limit, before) {
      // V2 pages hold at most 200 entries and include non-chat entries (idle,
      // model/agent switches), so keep paging until `limit` chat messages exist.
      const newestFirst: unknown[] = [];
      let cursor = before ? beforeCursor(before) : undefined;
      let converted: ReturnType<typeof v1Messages> = [];
      while (true) {
        const result = (await withTimeout(
          sdk.message.list({
            sessionID: id,
            limit: MESSAGE_PAGE_MAX,
            ...(cursor ? { cursor } : { order: "desc" }),
          } as never),
          OPENCODE_PROMPT_MS,
          "session.messages",
        )) as unknown as { data?: unknown[]; cursor?: { next?: string | null } };
        const data = result.data ?? [];
        newestFirst.push(...data);
        converted = v1Messages(id, [...newestFirst].reverse());
        const next = result.cursor?.next;
        if (data.length === 0 || !next || (limit !== undefined && converted.length >= limit)) break;
        cursor = next;
      }
      return limit === undefined ? converted : converted.slice(-limit);
    },
    async prompt(id, body) {
      await send(id, body, "steer");
      return {};
    },
    async promptAsync(id, body) {
      debugLog(`prompt ses=${id}`);
      const delivery = body.delivery === "queue" || body.delivery === "steer" ? body.delivery : undefined;
      await withTimeout(send(id, body, delivery), OPENCODE_PROMPT_MS, "session.prompt");
    },
    async abort(id) {
      await withTimeout(sdk.session.interrupt({ sessionID: id }), OPENCODE_REPLY_MS, "session.interrupt");
    },
    async revert(id, body) {
      const messageID = typeof body.messageID === "string" ? body.messageID : "";
      return sdk.session.revert.stage({ sessionID: id, messageID } as never);
    },
    async unrevert(id) {
      await sdk.session.revert.clear({ sessionID: id });
      return true;
    },
    async revertCommit(id) {
      await sdk.session.revert.commit({ sessionID: id });
    },
    async forkSession(id, body) {
      return v1Session(
        await sdk.session.fork({
          sessionID: id,
          ...(body?.messageID ? { before: body.messageID } : {}),
        }),
      );
    },
    async agents(directory) {
      const result = (await sdk.agent.list(location(directory) as never)) as unknown as { data?: Rec[] };
      return (result.data ?? []).map((agent) => ({
        name: String(agent.id),
        mode: typeof agent.mode === "string" ? agent.mode : undefined,
        hidden: agent.hidden === true,
        description: typeof agent.description === "string" ? agent.description : undefined,
      }));
    },
    async getConfig(directory) {
      try {
        const result = (await withTimeout(
          sdk.model.default(location(directory) as never),
          OPENCODE_SETUP_MS,
          "model.default",
        )) as unknown as { data?: Rec };
        const model = result.data;
        return model ? { model: `${model.providerID}/${model.id}` } : {};
      } catch {
        return {};
      }
    },
    async providers(directory) {
      const request = location(directory) as never;
      const providers = await (
        sdk.provider.list(request) as unknown as Promise<{ data?: Rec[] }>
      ).catch(() => ({ data: [] }));
      let models = (await sdk.model.list(request)) as unknown as {
        data?: Rec[];
      };
      if ((models.data?.length ?? 0) === 0) {
        // A cold OpenCode location can publish model.updated just after its
        // first successful model.list response, so retry the empty snapshot.
        await new Promise((resolve) =>
          setTimeout(resolve, MODEL_CATALOG_WARMUP_RETRY_MS),
        );
        models = (await sdk.model.list(request)) as unknown as {
          data?: Rec[];
        };
      }
      const names = new Map((providers.data ?? []).map((p) => [String(p.id), p.name]));
      const grouped = new Map<string, { id: string; name?: string; models: Record<string, unknown> }>();
      for (const model of models.data ?? []) {
        if (model.enabled === false) continue;
        const providerID = String(model.providerID);
        let entry = grouped.get(providerID);
        if (!entry) {
          const name = names.get(providerID);
          entry = { id: providerID, ...(typeof name === "string" ? { name } : {}), models: {} };
          grouped.set(providerID, entry);
        }
        entry.models[String(model.id)] = model;
      }
      return { providers: [...grouped.values()] };
    },
    async listCommands(directory) {
      const result = (await withTimeout(
        sdk.command.list(location(directory) as never),
        OPENCODE_SETUP_MS,
        "command.list",
      )) as unknown as { data?: Array<{ name: string; description?: string }> };
      return result.data ?? [];
    },
    async sessionCommand(id, body) {
      await applySessionSettings(id, {
        agent: body.agent,
        model: body.model,
        variant: body.variant,
      });
      await sdk.session.command({
        sessionID: id,
        name: body.command,
        text: body.arguments ?? "",
      } as never);
      return {};
    },
    async replyPermission({ requestID, sessionID, reply }) {
      await withTimeout(
        sdk.permission.reply({ sessionID, requestID, decision: reply } as never),
        OPENCODE_REPLY_MS,
        "permission.reply",
      );
      debugLog(`perm reply ${reply}`);
    },
    async listPendingPermissions(sessionID) {
      if (!sessionID) {
        const result = (await sdk.permission.request.list()) as unknown as { data?: unknown[] } | unknown[];
        const list = Array.isArray(result) ? result : (result.data ?? []);
        return list.map(v1PermissionAsk);
      }
      const list = (await sdk.permission.list({ sessionID })) as unknown as unknown[];
      return (Array.isArray(list) ? list : []).map(v1PermissionAsk);
    },
    async replyQuestion({ requestID, sessionID, answers }) {
      if (!answers) {
        await sdk.session.form.cancel({ sessionID, formID: requestID } as never);
        return;
      }
      let fields = questionFields.get(requestID);
      if (!fields) {
        const detail = (await sdk.session.form.get({ sessionID, formID: requestID } as never)) as unknown as Rec;
        fields = (Array.isArray(detail.fields) ? detail.fields : []).map((f) => ({
          key: String((f as Rec).key),
          type: String((f as Rec).type),
        }));
      }
      const answer: Record<string, string | string[]> = {};
      fields.forEach((field, index) => {
        const values = answers[index] ?? [];
        if (values.length === 0) return;
        answer[field.key] = field.type === "multiselect" ? values : values.join(", ");
      });
      await withTimeout(
        sdk.session.form.reply({ sessionID, formID: requestID, answer } as never),
        OPENCODE_REPLY_MS,
        "form.reply",
      );
      questionFields.delete(requestID);
    },
    async rejectQuestion({ requestID, sessionID }) {
      await sdk.session.form.cancel({ sessionID, formID: requestID } as never);
      questionFields.delete(requestID);
    },
    async listPendingQuestions(sessionID) {
      const forms = (await sdk.session.form.list({ sessionID })) as unknown as unknown[];
      return (Array.isArray(forms) ? forms : []).flatMap((form) => {
        const ask = v1QuestionAsk(form);
        if (!ask) return [];
        questionFields.set(String(ask.id), ask._fields as Array<{ key: string; type: string }>);
        return [ask];
      });
    },
    async sessionTodos() {
      return [];
    },
    async sessionIsRunning(id) {
      const active = await withTimeout(sdk.session.active(), OPENCODE_SETUP_MS, "session.active");
      return Boolean(active && typeof active === "object" && id in active);
    },
    async summarize(id) {
      startStream();
      const done = new Promise<void>((resolve, reject) => {
        compactWaiters.set(id, (error) => (error ? reject(new Error(error)) : resolve()));
      });
      try {
        await withTimeout(sdk.session.compact({ sessionID: id }), OPENCODE_REPLY_MS, "session.compact");
        await withTimeout(done, 10 * 60_000, "session.compaction");
      } finally {
        compactWaiters.delete(id);
      }
      return true;
    },
    async subscribe(handler) {
      handlers.set(handler, (handlers.get(handler) ?? 0) + 1);
      startStream();
      let released = false;
      return {
        unsubscribe() {
          if (released) return;
          released = true;
          const count = (handlers.get(handler) ?? 1) - 1;
          if (count > 0) handlers.set(handler, count);
          else handlers.delete(handler);
          if (handlers.size === 0) {
            stream?.abort();
            stream = undefined;
          }
        },
      };
    },
  };
}

export function acquireClient(
  factory: (url: string) => OpenCodeClient,
  cache: Map<string, OpenCodeClient>,
  url: string,
): OpenCodeClient {
  const existing = cache.get(url);
  if (existing) return existing;
  const created = factory(url);
  cache.set(url, created);
  return created;
}

export function createSdkClient(url: string): OpenCodeClient {
  const sdk = OpenCode.make({ baseUrl: url, headers: endpointHeaders.get(url) } as never);
  return wrap(url, sdk);
}
