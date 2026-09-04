import { createOpencodeClient } from "@opencode-ai/sdk";
import { listAuthenticatedProviders } from "./catalog.js";
import { runningSessionIdsFromStatus } from "./session-status.js";
import { debugLog } from "./debug-log.js";
import { isAbortTimeout } from "./process.js";

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
  abort(id: string): Promise<void>;
  revert(id: string, body: Record<string, unknown>): Promise<unknown>;
  unrevert(id: string): Promise<unknown>;
  forkSession(
    id: string,
    body?: { messageID?: string },
  ): Promise<OpenCodeSession>;
  agents(): Promise<OpenCodeAgentInfo[]>;
  providers(): Promise<{ providers: Array<{ id: string; models?: unknown }> }>;
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

function isJsonContentType(response: Response): boolean {
  const ct = response.headers.get("content-type") ?? "";
  return ct.includes("application/json") || ct.includes("text/plain") || ct === "";
}

function isJsonSuccess(response: Response): boolean {
  return response.ok && isJsonContentType(response);
}

async function readJsonArray(response: Response): Promise<unknown[]> {
  if (!isJsonSuccess(response)) return [];
  const body = (await response.json()) as unknown;
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data;
  }
  return [];
}

function askSessionId(ask: unknown): string | undefined {
  if (!ask || typeof ask !== "object") return undefined;
  const record = ask as Record<string, unknown>;
  if (typeof record.sessionID === "string") return record.sessionID;
  if (typeof record.sessionId === "string") return record.sessionId;
  return undefined;
}

type SdkClient = ReturnType<typeof createOpencodeClient>;

export const OPENCODE_SETUP_MS = 8_000;
export const OPENCODE_REPLY_MS = 8_000;
/** Revert cleanup can snapshot and delete a long suffix before prompt_async acks. */
export const OPENCODE_PROMPT_MS = 30_000;

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

async function fetchTimed(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

function unwrap<T>(result: unknown): T {
  if (result && typeof result === "object" && "data" in result) {
    const data = (result as { data?: T; error?: unknown }).data;
    const error = (result as { error?: unknown }).error;
    if (error) throw new Error(formatError(error));
    if (data !== undefined) return data;
  }
  return result as T;
}

function formatError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return JSON.stringify(error);
}

function wrap(url: string, sdk: SdkClient): OpenCodeClient {
  const rejectQuestion = async (args: {
    requestID: string;
    sessionID: string;
    directory?: string;
  }): Promise<void> => {
    const paths = [
      `/api/session/${args.sessionID}/question/${args.requestID}/reject`,
      `/question/${args.requestID}/reject`,
    ];
    for (const path of paths) {
      const response = await fetchTimed(
        `${url}${path}${directoryQuery(args.directory)}`,
        { method: "POST" },
        OPENCODE_REPLY_MS,
      );
      if (response.ok || response.status === 204 || response.status !== 404) {
        if (!response.ok && response.status !== 204) {
          throw new Error(`question.reject failed: ${response.status}`);
        }
        return;
      }
    }
  };
  return {
    url,
    async health() {
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(`${url}/global/health`, {
            signal: AbortSignal.timeout(800),
          });
          if (!response.ok) {
            throw new Error(`OpenCode health failed: ${response.status}`);
          }
          return (await response.json()) as OpenCodeHealth;
        } catch (error) {
          last = error;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
      const detail = isAbortTimeout(last)
        ? "timed out"
        : last instanceof Error
          ? last.message
          : String(last);
      throw new Error(`OpenCode serve did not answer health (${detail})`);
    },
    async createSession(args) {
      const result = await withTimeout(
        sdk.session.create({
          query: args.directory ? { directory: args.directory } : undefined,
          body: {
            ...(args.title ? { title: args.title } : {}),
            ...(args.parentID ? { parentID: args.parentID } : {}),
          },
        }),
        OPENCODE_SETUP_MS,
        "session.create",
      );
      return unwrap<OpenCodeSession>(result);
    },
    async getSession(id) {
      const result = await withTimeout(
        sdk.session.get({ path: { id } }),
        OPENCODE_SETUP_MS,
        "session.get",
      );
      return unwrap<OpenCodeSession>(result);
    },
    async updateSession(id, body) {
      const result = await sdk.session.update({
        path: { id },
        body,
      });
      return unwrap<OpenCodeSession>(result);
    },
    async listSessions() {
      const result = await withTimeout(
        sdk.session.list(),
        OPENCODE_SETUP_MS,
        "session.list",
      );
      return unwrap<OpenCodeSession[]>(result) ?? [];
    },
    async sessionChildren(id, directory) {
      const result = await sdk.session.children({
        path: { id },
        ...(directory ? { query: { directory } } : {}),
      });
      return unwrap<OpenCodeSession[]>(result) ?? [];
    },
    async sessionMessages(id, limit, before) {
      const query = {
        ...(limit === undefined ? {} : { limit }),
        ...(before === undefined ? {} : { before }),
      };
      const result = await withTimeout(
        sdk.session.messages({
          path: { id },
          ...(Object.keys(query).length === 0 ? {} : { query }),
        } as never),
        OPENCODE_SETUP_MS,
        "session.messages",
      );
      return (
        unwrap<
          Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
        >(result) ?? []
      );
    },
    async prompt(id, body, directory) {
      const query = directoryQuery(directory);
      debugLog(`prompt ses=${id} dir=${directory || "-"}`);
      const send = (payload: Record<string, unknown>) =>
        fetchTimed(
          `${url}/session/${id}/message${query}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
          OPENCODE_REPLY_MS,
        );
      let response = await send(body);
      if (!response.ok && response.status === 400 && "variant" in body) {
        const { variant: _variant, thinking: _thinking, ...rest } = body;
        response = await send(rest);
      }
      if (!response.ok) {
        throw new Error(`session.prompt failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    },
    async promptAsync(id, body, directory) {
      const query = directoryQuery(directory);
      debugLog(`prompt_async ses=${id} dir=${directory || "-"}`);
      const send = (payload: Record<string, unknown>) =>
        fetchTimed(
          `${url}/session/${id}/prompt_async${query}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
          OPENCODE_PROMPT_MS,
        );
      let response = await send(body);
      if (response.status === 404) {
        void fetch(`${url}/session/${id}/message${query}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).catch(() => undefined);
        return;
      }
      if (!response.ok && response.status === 400 && "variant" in body) {
        const { variant: _variant, thinking: _thinking, ...rest } = body;
        response = await send(rest);
      }
      if (!response.ok) {
        throw new Error(
          `session.prompt_async failed: ${response.status} ${await response.text()}`,
        );
      }
    },
    async abort(id) {
      await withTimeout(
        sdk.session.abort({ path: { id } }),
        OPENCODE_REPLY_MS,
        "session.abort",
      );
    },
    async revert(id, body) {
      const result = await sdk.session.revert({
        path: { id },
        body: body as never,
      });
      return unwrap(result);
    },
    async unrevert(id) {
      const result = await sdk.session.unrevert({ path: { id } });
      return unwrap(result);
    },
    async forkSession(id, body) {
      const result = await sdk.session.fork({
        path: { id },
        body: body ?? {},
      });
      return unwrap<OpenCodeSession>(result);
    },
    async agents() {
      const result = await sdk.app.agents();
      return unwrap<OpenCodeAgentInfo[]>(result) ?? [];
    },
    async getConfig(directory) {
      if (directory) {
        const response = await fetchTimed(
          `${url}/config${directoryQuery(directory)}`,
          {},
          OPENCODE_SETUP_MS,
        );
        if (!response.ok) {
          throw new Error(`config.get failed: ${response.status}`);
        }
        return response.json();
      }
      const result = await withTimeout(
        sdk.config.get(),
        OPENCODE_SETUP_MS,
        "config.get",
      );
      return unwrap<unknown>(result);
    },
    async providers() {
      const result = unwrap<unknown>(await sdk.provider.list());
      return { providers: listAuthenticatedProviders(result) };
    },
    async listCommands(directory) {
      const query = directoryQuery(directory);
      const response = await fetchTimed(
        `${url}/command${query}`,
        {},
        OPENCODE_SETUP_MS,
      );
      if (!response.ok) {
        throw new Error(`command.list failed: ${response.status}`);
      }
      const body = (await response.json()) as unknown;
      return Array.isArray(body) ? (body as Array<{ name: string; description?: string }>) : [];
    },
    async sessionCommand(id, body, directory) {
      const response = await fetch(
        `${url}/session/${id}/command${directoryQuery(directory)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        throw new Error(`session.command failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    },
    async replyPermission({ requestID, sessionID, reply, directory }) {
      const query = directoryQuery(directory);
      const attempts: Array<{ path: string; body: unknown }> = [
        {
          path: `/session/${sessionID}/permissions/${requestID}${query}`,
          body: { response: reply },
        },
        {
          path: `/permission/${requestID}/reply${query}`,
          body: { reply },
        },
        {
          path: `/api/session/${sessionID}/permission/${requestID}/reply`,
          body: { reply },
        },
      ];
      let lastStatus = 0;
      for (const attempt of attempts) {
        const response = await fetchTimed(
          `${url}${attempt.path}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(attempt.body),
          },
          OPENCODE_REPLY_MS,
        );
        if (isJsonSuccess(response)) {
          debugLog(`perm reply ${reply} ${attempt.path}`);
          return;
        }
        lastStatus = response.status;
        if (response.ok) continue;
        if (response.status !== 404) {
          throw new Error(`permission.reply failed: ${response.status}`);
        }
      }
      throw new Error(`permission.reply failed: ${lastStatus || 404}`);
    },
    async listPendingPermissions(sessionID, directory) {
      const asks: unknown[] = [];
      const scoped = await fetchTimed(
        `${url}/permission${directoryQuery(directory)}`,
        {},
        OPENCODE_SETUP_MS,
      );
      asks.push(...(await readJsonArray(scoped)));
      if (asks.length === 0 && sessionID) {
        const v2 = await fetchTimed(
          `${url}/api/session/${sessionID}/permission`,
          {},
          OPENCODE_SETUP_MS,
        );
        asks.push(...(await readJsonArray(v2)));
      }
      const scopedAsks = sessionID
        ? asks.filter((ask) => {
            const sid = askSessionId(ask);
            return !sid || sid === sessionID;
          })
        : asks;
      if (scopedAsks.length > 0) {
        debugLog(`perm n=${scopedAsks.length} dir=${directory || "-"}`);
      }
      return scopedAsks;
    },
    async replyQuestion({ requestID, sessionID, answers, directory }) {
      if (!answers) {
        await rejectQuestion({ requestID, sessionID, directory });
        return;
      }
      const paths = [
        `/api/session/${sessionID}/question/${requestID}/reply`,
        `/question/${requestID}/reply`,
        `/session/${sessionID}/question/${requestID}`,
      ];
      for (const path of paths) {
        const response = await fetchTimed(
          `${url}${path}${directoryQuery(directory)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ answers }),
          },
          OPENCODE_REPLY_MS,
        );
        if (response.ok || response.status === 204 || response.status !== 404) {
          if (!response.ok && response.status !== 204) {
            throw new Error(`question.reply failed: ${response.status}`);
          }
          return;
        }
      }
      throw new Error("question.reply not available");
    },
    rejectQuestion,
    async listPendingQuestions(sessionID, directory) {
      const response = await fetchTimed(
        `${url}/api/session/${sessionID}/question${directoryQuery(directory)}`,
        {},
        OPENCODE_SETUP_MS,
      );
      if (!response.ok) return [];
      const body = (await response.json()) as { data?: unknown } | unknown[];
      if (Array.isArray(body)) return body;
      return Array.isArray(body.data) ? body.data : [];
    },
    async sessionTodos(id) {
      const result = await sdk.session.todo({ path: { id } });
      const body = unwrap<unknown>(result);
      return Array.isArray(body) ? body : [];
    },
    async sessionIsRunning(id, directory) {
      const response = await fetchTimed(
        `${url}/session/status${directoryQuery(directory)}`,
        {},
        OPENCODE_SETUP_MS,
      );
      if (!response.ok) {
        throw new Error(`session.status failed: ${response.status}`);
      }
      if (!isJsonContentType(response)) {
        throw new Error("session.status was not JSON");
      }
      const body = (await response.json()) as unknown;
      return runningSessionIdsFromStatus(body).has(id);
    },
    async summarize(id, body) {
      const result = await withTimeout(
        sdk.session.summarize({
          path: { id },
          body,
        }),
        OPENCODE_REPLY_MS,
        "session.summarize",
      );
      return Boolean(unwrap<boolean>(result));
    },
    async subscribe(handler, directory) {
      const controller = new AbortController();
      void (async () => {
        try {
          const response = await fetch(`${url}/event${directoryQuery(directory)}`, {
            headers: { accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`event.subscribe failed: ${response.status}`);
          }
          const reader = response.body
            .pipeThrough(new TextDecoderStream())
            .getReader();
          let buffer = "";
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) {
              if (!controller.signal.aborted) {
                handler({ type: "server.disconnected" });
              }
              break;
            }
            buffer += value;
            const chunks = buffer.split("\n\n");
            buffer = chunks.pop() ?? "";
            for (const chunk of chunks) {
              const dataLines = chunk
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.replace(/^data:\s*/, ""));
              if (dataLines.length === 0) continue;
              try {
                const parsed = JSON.parse(dataLines.join("\n")) as {
                  type?: string;
                  properties?: unknown;
                  data?: unknown;
                  payload?: {
                    type?: string;
                    properties?: unknown;
                    data?: unknown;
                  };
                };
                const event =
                  typeof parsed.type === "string"
                    ? parsed
                    : parsed.payload && typeof parsed.payload.type === "string"
                      ? parsed.payload
                      : undefined;
                if (event?.type) {
                  handler({
                    type: event.type,
                    properties: event.properties ?? event.data,
                  });
                }
              } catch {
                /* ignore malformed SSE frames */
              }
            }
          }
        } catch {
          if (!controller.signal.aborted) {
            handler({ type: "server.disconnected" });
          }
        }
      })();
      return {
        unsubscribe() {
          controller.abort();
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
  const sdk = createOpencodeClient({ baseUrl: url });
  return wrap(url, sdk);
}
