import { createOpencodeClient } from "@opencode-ai/sdk";
import { listAuthenticatedProviders } from "./catalog.js";

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
  sessionChildren(id: string): Promise<OpenCodeSession[]>;
  sessionMessages(id: string): Promise<
    Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  >;
  prompt(id: string, body: Record<string, unknown>): Promise<unknown>;
  promptAsync(id: string, body: Record<string, unknown>): Promise<void>;
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
  ): Promise<unknown>;
  getConfig(): Promise<unknown>;
  replyPermission(args: {
    requestID: string;
    sessionID: string;
    reply: "once" | "always" | "reject";
  }): Promise<void>;
  listPendingPermissions(sessionID?: string): Promise<unknown[]>;
  replyQuestion(args: {
    requestID: string;
    sessionID: string;
    answers?: string[][];
  }): Promise<void>;
  rejectQuestion(args: {
    requestID: string;
    sessionID: string;
  }): Promise<void>;
  listPendingQuestions(sessionID: string): Promise<unknown[]>;
  sessionIsRunning(id: string): Promise<boolean>;
  sessionTodos(id: string): Promise<unknown[]>;
  summarize(
    id: string,
    body: { providerID: string; modelID: string },
  ): Promise<boolean>;
  subscribe(
    handler: (event: { type: string; properties?: unknown }) => void,
  ): Promise<{ unsubscribe(): void }>;
}

type SdkClient = ReturnType<typeof createOpencodeClient>;

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
  }): Promise<void> => {
    const paths = [
      `/api/session/${args.sessionID}/question/${args.requestID}/reject`,
      `/question/${args.requestID}/reject`,
    ];
    for (const path of paths) {
      const response = await fetch(`${url}${path}`, { method: "POST" });
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
      const response = await fetch(`${url}/global/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        throw new Error(`OpenCode health failed: ${response.status}`);
      }
      return (await response.json()) as OpenCodeHealth;
    },
    async createSession(args) {
      const result = await sdk.session.create({
        query: args.directory ? { directory: args.directory } : undefined,
        body: {
          ...(args.title ? { title: args.title } : {}),
          ...(args.parentID ? { parentID: args.parentID } : {}),
        },
      });
      return unwrap<OpenCodeSession>(result);
    },
    async getSession(id) {
      const result = await sdk.session.get({ path: { id } });
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
      const result = await sdk.session.list();
      return unwrap<OpenCodeSession[]>(result) ?? [];
    },
    async sessionChildren(id) {
      const result = await sdk.session.children({ path: { id } });
      return unwrap<OpenCodeSession[]>(result) ?? [];
    },
    async sessionMessages(id) {
      const result = await sdk.session.messages({ path: { id } });
      return (
        unwrap<
          Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
        >(result) ?? []
      );
    },
    async prompt(id, body) {
      const send = (payload: Record<string, unknown>) =>
        fetch(`${url}/session/${id}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
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
    async promptAsync(id, body) {
      const send = (payload: Record<string, unknown>) =>
        fetch(`${url}/session/${id}/prompt_async`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      let response = await send(body);
      if (response.status === 404) {
        void fetch(`${url}/session/${id}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
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
      await sdk.session.abort({ path: { id } });
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
    async getConfig() {
      const result = await sdk.config.get();
      return unwrap<unknown>(result);
    },
    async providers() {
      const result = unwrap<unknown>(await sdk.provider.list());
      return { providers: listAuthenticatedProviders(result) };
    },
    async listCommands(directory) {
      const query = directory
        ? `?directory=${encodeURIComponent(directory)}`
        : "";
      const response = await fetch(`${url}/command${query}`);
      if (!response.ok) {
        throw new Error(`command.list failed: ${response.status}`);
      }
      const body = (await response.json()) as unknown;
      return Array.isArray(body) ? (body as Array<{ name: string; description?: string }>) : [];
    },
    async sessionCommand(id, body) {
      const response = await fetch(`${url}/session/${id}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`session.command failed: ${response.status} ${await response.text()}`);
      }
      return response.json();
    },
    async replyPermission({ requestID, sessionID, reply }) {
      const attempts: Array<{ path: string; body: unknown }> = [
        {
          path: `/api/session/${sessionID}/permission/${requestID}/reply`,
          body: { reply },
        },
        {
          path: `/session/${sessionID}/permissions/${requestID}`,
          body: { response: reply },
        },
        {
          path: `/permission/${requestID}/reply`,
          body: { reply },
        },
      ];
      let lastStatus = 0;
      for (const attempt of attempts) {
        const response = await fetch(`${url}${attempt.path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(attempt.body),
        });
        if (response.ok) return;
        lastStatus = response.status;
        if (response.status !== 404) {
          throw new Error(`permission.reply failed: ${response.status}`);
        }
      }
      throw new Error(`permission.reply failed: ${lastStatus || 404}`);
    },
    async listPendingPermissions(sessionID) {
      const asks: unknown[] = [];
      if (sessionID) {
        const v2 = await fetch(`${url}/api/session/${sessionID}/permission`);
        if (v2.ok) {
          const body = (await v2.json()) as { data?: unknown } | unknown[];
          const rows = Array.isArray(body)
            ? body
            : Array.isArray(body.data)
              ? body.data
              : [];
          asks.push(...rows);
        }
      }
      const v1 = await fetch(`${url}/permission`);
      if (v1.ok) {
        const body = (await v1.json()) as unknown;
        if (Array.isArray(body)) asks.push(...body);
      }
      return asks;
    },
    async replyQuestion({ requestID, sessionID, answers }) {
      if (!answers) {
        await rejectQuestion({ requestID, sessionID });
        return;
      }
      const paths = [
        `/api/session/${sessionID}/question/${requestID}/reply`,
        `/question/${requestID}/reply`,
        `/session/${sessionID}/question/${requestID}`,
      ];
      for (const path of paths) {
        const response = await fetch(`${url}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers }),
        });
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
    async listPendingQuestions(sessionID) {
      const response = await fetch(
        `${url}/api/session/${sessionID}/question`,
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
    async sessionIsRunning(id) {
      const response = await fetch(`${url}/session/status`);
      if (!response.ok) return false;
      const body = (await response.json()) as unknown;
      if (Array.isArray(body)) {
        return body.some((item) => {
          if (!item || typeof item !== "object") return false;
          const row = item as { id?: unknown; status?: unknown };
          return row.id === id && row.status && row.status !== "idle";
        });
      }
      if (body && typeof body === "object") {
        const status = (body as Record<string, unknown>)[id];
        if (typeof status === "string") return status !== "idle";
        if (status && typeof status === "object") {
          const value = (status as { status?: unknown }).status;
          return typeof value === "string" && value !== "idle";
        }
      }
      return false;
    },
    async summarize(id, body) {
      const result = await sdk.session.summarize({
        path: { id },
        body,
      });
      return Boolean(unwrap<boolean>(result));
    },
    async subscribe(handler) {
      const controller = new AbortController();
      void (async () => {
        try {
          const response = await fetch(`${url}/event`, {
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
            if (done) break;
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
