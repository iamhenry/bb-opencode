import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  skillsConfigureParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { createSdkClient, type OpenCodeClient } from "./client.js";
import { hydrateDeltas, lastUserAgent, type HydrateMessage } from "./hydrate.js";
import {
  closeText,
  createMapDeltaState,
  formatUnknownTally,
  mapPartDelta,
  tallyUnknown,
  type MapDeltaState,
  type ThreadDelta,
} from "./map-delta.js";
import {
  decisionToReply,
  isPermissionAskEvent,
  mapPermissionAsk,
  shouldAutoApprove,
  shouldShowCard,
} from "./permissions/map.js";
import { attachOrSpawn } from "./process.js";
import { buildPrompt } from "./prompt-builder.js";
import { formatSkillAppendix, type SkillConfigureRoot } from "./skill-appendix.js";
import {
  firstTextPart,
  hasNonTextParts,
  matchListedCommand,
  parseLeadingSlash,
} from "./slash-command.js";
import { formatModelDisplayName } from "./model-label.js";
import {
  resolvePermissionAttach,
} from "./permissions/target.js";
import {
  hydratePickerAgent,
  listSelectablePrimaries,
  type OpenCodeAgent,
} from "./selectable-primaries.js";
import { isVersionInWindow, versionSkewMessage } from "./identity.js";

type JsonRpcId = string | number;

export interface BridgeDeps {
  acquire(url: string): OpenCodeClient;
  attach(dataDir: string): Promise<{ url: string; pid: number; port: number }>;
  write(message: Record<string, unknown>): void;
  now?: () => number;
}

interface LiveTurn {
  threadId: string;
  sessionId: string;
  promptIssued: boolean;
  mapState: MapDeltaState;
  textBuffers: Map<string, string>;
  parentBoundaryEmitted: boolean;
  liveChildIds: Set<string>;
}

interface BoundSession {
  threadId: string;
  sessionId: string;
  cwd: string;
  permissionMode?: string;
  lastSnapshot?: unknown;
}

const sessions = new Map<string, BoundSession>();
const sessionToThread = new Map<string, string>();
const liveTurns = new Map<string, LiveTurn>();
let configuredSkillRoots: SkillConfigureRoot[] = [];
const pendingPermission = new Map<
  string,
  { requestId: string; sessionId: string; threadId: string }
>();

let dataDir = "";
let client: OpenCodeClient | undefined;
let subscribed = false;
let createCount = 0;
let unknownLogLines: string[] = [];
let titleTimer: ReturnType<typeof setInterval> | undefined;
const lastTitles = new Map<string, string>();
let deps: BridgeDeps = {
  acquire: createSdkClient,
  attach: async (dir) => attachOrSpawn({ dataDir: dir }),
  write: (message) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  },
};

export function getCreateCount(): number {
  return createCount;
}

export function resetBridgeForTests(next?: Partial<BridgeDeps>): void {
  sessions.clear();
  sessionToThread.clear();
  liveTurns.clear();
  pendingPermission.clear();
  configuredSkillRoots = [];
  lastTitles.clear();
  if (titleTimer) {
    clearInterval(titleTimer);
    titleTimer = undefined;
  }
  client = undefined;
  subscribed = false;
  createCount = 0;
  unknownLogLines = [];
  dataDir = "/tmp/bb-oc-bridge-test";
  deps = {
    acquire: next?.acquire ?? createSdkClient,
    attach: next?.attach ?? (async (dir) => attachOrSpawn({ dataDir: dir })),
    write:
      next?.write ??
      ((message) => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      }),
  };
}

export async function ingestOpenCodeEvent(event: {
  type: string;
  properties?: unknown;
}): Promise<void> {
  await onOpenCodeEvent(event);
}

export function recentUnknownLogLines(): string[] {
  return [...unknownLogLines];
}

function respondResult(id: JsonRpcId, result: unknown): void {
  deps.write({ id, result });
}

function respondError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): void {
  deps.write({
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

function notify(method: string, params: Record<string, unknown>): void {
  deps.write({ method, params });
}

function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  if (deltas.length === 0) return;
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

async function ensureClient(): Promise<OpenCodeClient> {
  if (client) return client;
  if (!dataDir) throw new Error("bridge dataDir is not set");
  const attached = await deps.attach(dataDir);
  client = deps.acquire(attached.url);
  const health = await client.health();
  if (!isVersionInWindow(health.version)) {
    throw new Error(versionSkewMessage(health.version));
  }
  await ensureSubscribed(client);
  return client;
}

function failLiveTurns(message: string): void {
  for (const [threadId, live] of liveTurns) {
    if (live.parentBoundaryEmitted) continue;
    live.parentBoundaryEmitted = true;
    emitDeltas(threadId, [
      {
        kind: "turn.boundary",
        status: "error",
        error: { message },
      },
    ]);
  }
  liveTurns.clear();
}

async function ensureSubscribed(active: OpenCodeClient): Promise<void> {
  if (subscribed) return;
  subscribed = true;
  const sub = await active.subscribe((event) => {
    void onOpenCodeEvent(event).catch((error) => {
      unknownLogLines.push(`event-handler-error ${String(error)}`);
    });
  });
  void Promise.resolve(sub).then((handle) => {
    const original = handle.unsubscribe;
    handle.unsubscribe = () => {
      original.call(handle);
      failLiveTurns("OpenCode event stream closed");
    };
  });
}

function bindSession(threadId: string, session: BoundSession): void {
  sessions.set(threadId, session);
  sessionToThread.set(session.sessionId, threadId);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId,
    providerThreadId: session.sessionId,
  });
  startTitlePoller();
  void syncSessionTitle(session.sessionId);
}

function startTitlePoller(): void {
  if (titleTimer) return;
  titleTimer = setInterval(() => {
    void Promise.all(
      [...sessionToThread.keys()].map((sessionId) => syncSessionTitle(sessionId)),
    );
  }, 2000);
  titleTimer.unref?.();
}

export async function syncSessionTitle(sessionId: string): Promise<boolean> {
  if (!client) return false;
  const threadId = sessionToThread.get(sessionId);
  if (!threadId) return false;
  try {
    const session = await client.getSession(sessionId);
    const title = session.title;
    if (title && lastTitles.get(sessionId) !== title) {
      lastTitles.set(sessionId, title);
      emitDeltas(threadId, [{ kind: "thread.name", name: title }]);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function hydrateBoundSession(sessionId: string): Promise<boolean> {
  const threadId = sessionToThread.get(sessionId);
  if (!threadId || !client) return false;
  await replayHydrate(threadId, sessionId, client);
  return true;
}

function providerOptions(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const record = options as { providerOptions?: unknown };
  if (!record.providerOptions || typeof record.providerOptions !== "object") {
    return {};
  }
  return record.providerOptions as Record<string, unknown>;
}

function permissionModeOf(options: unknown): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const mode = (options as { permissionMode?: unknown }).permissionMode;
  return typeof mode === "string" ? mode : undefined;
}

async function replayHydrate(
  threadId: string,
  sessionId: string,
  active: OpenCodeClient,
): Promise<void> {
  const messages = (await active.sessionMessages(sessionId)) as HydrateMessage[];
  emitDeltas(threadId, hydrateDeltas({ sessionId, messages }));
}

function eventSessionId(event: { type: string; properties?: unknown }): string | undefined {
  const properties = event.properties;
  if (!properties || typeof properties !== "object") return undefined;
  const record = properties as Record<string, unknown>;
  if (typeof record.sessionID === "string") return record.sessionID;
  const info = record.info;
  if (info && typeof info === "object" && typeof (info as { sessionID?: unknown }).sessionID === "string") {
    return (info as { sessionID: string }).sessionID;
  }
  const part = record.part;
  if (part && typeof part === "object" && typeof (part as { sessionID?: unknown }).sessionID === "string") {
    return (part as { sessionID: string }).sessionID;
  }
  return undefined;
}

async function onOpenCodeEvent(event: {
  type: string;
  properties?: unknown;
}): Promise<void> {
  if (event.type === "server.disconnected") {
    failLiveTurns("OpenCode event stream closed");
    return;
  }
  const sessionId = eventSessionId(event);
  if (!sessionId) {
    if (event.type.startsWith("permission.")) {
      return;
    }
    return;
  }
  const threadId = sessionToThread.get(sessionId);
  const live = threadId ? liveTurns.get(threadId) : undefined;

  if (isPermissionAskEvent(event.type)) {
    await handlePermissionAsked(event.properties, sessionId);
    return;
  }

  if (event.type === "session.updated" || event.type === "session.diff") {
    const title = sessionTitle(event.properties);
    if (title && threadId) {
      lastTitles.set(sessionId, title);
      emitDeltas(threadId, [{ kind: "thread.name", name: title }]);
      return;
    }
    void syncSessionTitle(sessionId);
    return;
  }

  if (!threadId || !live) {
    if (threadId && event.type) {
      unknownLogLines.push(`unknown-events session=${sessionId} ${event.type}=1`);
    }
    return;
  }

  if (sessionId !== live.sessionId) {
    const parentId = eventParentId(event.properties);
    if (parentId === live.sessionId) {
      live.liveChildIds.add(sessionId);
    }
    if (event.type === "session.idle" || event.type === "session.status") {
      live.liveChildIds.delete(sessionId);
    }
    return;
  }

  if (event.type === "message.part.delta" || event.type === "message.part.updated") {
    const part =
      event.properties && typeof event.properties === "object"
        ? ((event.properties as { part?: Record<string, unknown> }).part ??
          event.properties)
        : undefined;
    if (part && typeof part === "object") {
      const childId = taskChildSessionId(part as Record<string, unknown>);
      if (childId) live.liveChildIds.add(childId);
      emitDeltas(
        threadId,
        mapPartDelta({
          state: live.mapState,
          part,
          sessionId,
        }),
      );
      const typed = part as { id?: string; type?: string; text?: string };
      if (typed.type === "text" && typed.text && typed.id) {
        live.textBuffers.set(typed.id, typed.text);
      }
    }
    return;
  }

  if (event.type === "session.idle" || event.type === "session.status") {
    const status =
      event.properties && typeof event.properties === "object"
        ? (event.properties as { status?: unknown }).status
        : undefined;
    const idle = event.type === "session.idle" || status === "idle";
    if (!idle) return;
    if (sessionId !== live.sessionId) {
      live.liveChildIds.delete(sessionId);
      return;
    }
    if (!live.parentBoundaryEmitted) {
      live.parentBoundaryEmitted = true;
      for (const [id, text] of live.textBuffers) {
        emitDeltas(threadId, closeText(id, text));
      }
      emitDeltas(threadId, [{ kind: "turn.boundary", status: "completed" }]);
      liveTurns.delete(threadId);
      if (live.mapState.unknownTally.size > 0) {
        unknownLogLines.push(
          `unknown-events session=${sessionId} ${formatUnknownTally(live.mapState)}`,
        );
      }
    }
    return;
  }

  if (event.type === "session.error") {
    if (sessionId === live.sessionId && !live.parentBoundaryEmitted) {
      live.parentBoundaryEmitted = true;
      emitDeltas(threadId, [
        {
          kind: "turn.boundary",
          status: "error",
          error: { message: "OpenCode session error" },
        },
      ]);
      liveTurns.delete(threadId);
    }
    return;
  }

  tallyUnknown(live.mapState, event.type);
}

function eventParentId(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const record = properties as Record<string, unknown>;
  if (typeof record.parentID === "string") return record.parentID;
  const info = record.info;
  if (info && typeof info === "object") {
    const parentID = (info as { parentID?: unknown }).parentID;
    if (typeof parentID === "string") return parentID;
  }
  return undefined;
}

function taskChildSessionId(part: Record<string, unknown>): string | undefined {
  const tool = part.tool;
  if (tool !== "task" && tool !== "Task") return undefined;
  const state =
    part.state && typeof part.state === "object"
      ? (part.state as Record<string, unknown>)
      : {};
  const metadata =
    state.metadata && typeof state.metadata === "object"
      ? (state.metadata as Record<string, unknown>)
      : {};
  for (const value of [
    state.sessionID,
    state.sessionId,
    metadata.sessionID,
    metadata.sessionId,
  ]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function sessionTitle(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const record = properties as Record<string, unknown>;
  if (typeof record.title === "string" && record.title.length > 0) {
    return record.title;
  }
  const info = record.info;
  if (info && typeof info === "object") {
    const title = (info as { title?: unknown }).title;
    if (typeof title === "string" && title.length > 0) return title;
  }
  return undefined;
}

async function handlePermissionAsked(
  properties: unknown,
  sessionId: string,
): Promise<void> {
  const mapped = mapPermissionAsk(properties);
  const active = client;
  if (!active) return;

  const parentThread = sessionToThread.get(sessionId);
  let parentSessionId: string | null = null;
  if (!parentThread) {
    try {
      const session = await active.getSession(sessionId);
      parentSessionId = session.parentID ?? null;
    } catch {
      parentSessionId = null;
    }
  }
  const parentThreadId = parentSessionId
    ? sessionToThread.get(parentSessionId) ?? null
    : null;
  const parentLive = parentThreadId ? liveTurns.get(parentThreadId) : undefined;
  const attach = resolvePermissionAttach({
    askSessionId: sessionId,
    boundThreadId: parentThread ?? null,
    parentSessionId,
    parentThreadId,
    parentInFlight: Boolean(parentLive && !parentLive.parentBoundaryEmitted),
  });
  if (attach.action === "drop") return;
  const targetThreadId = attach.threadId;
  if (parentLive && parentSessionId) {
    parentLive.liveChildIds.add(sessionId);
  }

  const live = liveTurns.get(targetThreadId);
  const permissionMode = sessions.get(targetThreadId)?.permissionMode;

  if (mapped.tag === "unknown" || !mapped.requestId || !mapped.subject) {
    return;
  }
  if (shouldAutoApprove({ tag: mapped.tag, permissionMode })) {
    await active.replyPermission({
      requestID: mapped.requestId,
      sessionID: sessionId,
      reply: "once",
    });
    return;
  }
  if (!shouldShowCard({ tag: mapped.tag, permissionMode })) {
    return;
  }
  if (!live) return;

  const requestId = `oc-perm-${mapped.requestId}`;
  pendingPermission.set(requestId, {
    requestId: mapped.requestId,
    sessionId,
    threadId: targetThreadId,
  });
  deps.write({
    id: requestId,
    method: BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
    params: {
      providerThreadId: sessionId,
      threadId: targetThreadId,
      turnId: null,
      providerNativeIds: true,
      payload: {
        kind: "approval",
        subject: mapped.subject,
        reason: null,
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    },
  });
}

async function resolveSelectableAgent(args: {
  active: OpenCodeClient;
  requested: string | undefined;
  sessionId: string;
}): Promise<{ ok: true; agent: string } | { ok: false; reason: string }> {
  const agents = (await args.active.agents()) as OpenCodeAgent[];
  const selectable = listSelectablePrimaries(agents);
  if (args.requested) {
    if (selectable.some((agent) => agent.name === args.requested)) {
      return { ok: true, agent: args.requested };
    }
    return {
      ok: false,
      reason: `Unknown or non-selectable OpenCode agent: ${args.requested}`,
    };
  }
  const messages = (await args.active.sessionMessages(args.sessionId)) as HydrateMessage[];
  const hydrated = hydratePickerAgent({
    lastUserAgent: lastUserAgent(messages),
    agents,
  });
  if (hydrated.status === "unknown") {
    return {
      ok: false,
      reason: `Unknown OpenCode agent: ${hydrated.agent}`,
    };
  }
  return { ok: true, agent: hydrated.agent };
}

const handlers: Record<string, (id: JsonRpcId, params: unknown) => void> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "Invalid params for initialize",
        parsed.error.issues,
      );
      return;
    }
    respondResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        sessionRestore: true,
        fork: "none",
        approvalEnforcedBy: "provider",
        steerMode: "queue",
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "Invalid params for model/list",
        parsed.error.issues,
      );
      return;
    }
    void (async () => {
      try {
        const active = await ensureClient();
        const catalog = await active.providers();
        const models = (catalog.providers ?? []).flatMap((provider) => {
          const modelsRecord =
            provider.models && typeof provider.models === "object"
              ? provider.models
              : {};
          return Object.keys(modelsRecord as Record<string, unknown>).map(
            (modelId) => {
              const raw = (modelsRecord as Record<string, { name?: string }>)[
                modelId
              ];
              return {
                id: `${provider.id}/${modelId}`,
                model: modelId,
                displayName: formatModelDisplayName(
                  provider.id,
                  raw?.name ?? modelId,
                ),
                description: provider.id,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Low" },
                  { reasoningEffort: "medium", description: "Medium" },
                  { reasoningEffort: "high", description: "High" },
                ],
                defaultReasoningEffort: "medium",
                isDefault: false,
              };
            },
          );
        });
        const preferred =
          models.find((model) => /openai|anthropic|opencode/i.test(model.id)) ??
          models[0];
        if (preferred) preferred.isDefault = true;
        respondResult(id, { models, selectedOnlyModels: [] });
      } catch (error) {
        respondError(
          id,
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "Invalid params for thread/start",
        parsed.error.issues,
      );
      return;
    }
    void (async () => {
      try {
        const active = await ensureClient();
        const options = providerOptions(parsed.data.options);
        const adoptId =
          typeof options.adoptSessionId === "string"
            ? options.adoptSessionId
            : undefined;
        let sessionId = adoptId;
        if (!sessionId) {
          const created = await active.createSession({
            directory: parsed.data.cwd,
          });
          createCount += 1;
          sessionId = created.id;
        }
        const bound: BoundSession = {
          threadId: parsed.data.threadId,
          sessionId,
          cwd: parsed.data.cwd,
          permissionMode: permissionModeOf(parsed.data.options),
        };
        bindSession(parsed.data.threadId, bound);
        emitDeltas(parsed.data.threadId, [{ kind: "session.reset" }]);
        respondResult(id, { providerThreadId: sessionId });
        if (adoptId) {
          await replayHydrate(parsed.data.threadId, sessionId, active);
        }
        const input = parsed.data.input ?? [];
        if (input.length > 0) {
          await runPrompt({
            threadId: parsed.data.threadId,
            sessionId,
            input,
            options: parsed.data.options,
            clientRequestId: undefined,
          });
        }
      } catch (error) {
        respondError(
          id,
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "Invalid params for thread/resume",
        parsed.error.issues,
      );
      return;
    }
    void (async () => {
      try {
        const active = await ensureClient();
        await active.getSession(parsed.data.providerThreadId);
        bindSession(parsed.data.threadId, {
          threadId: parsed.data.threadId,
          sessionId: parsed.data.providerThreadId,
          cwd: parsed.data.cwd,
          permissionMode: permissionModeOf(parsed.data.options),
        });
        respondResult(id, { providerThreadId: parsed.data.providerThreadId });
        await replayHydrate(
          parsed.data.threadId,
          parsed.data.providerThreadId,
          active,
        );
      } catch (error) {
        respondError(
          id,
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "Invalid params for turn/start",
        parsed.error.issues,
      );
      return;
    }
    void (async () => {
      try {
        const bound = sessions.get(parsed.data.threadId);
        if (!bound) {
          respondError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "Unknown thread");
          return;
        }
        bound.permissionMode = permissionModeOf(parsed.data.options);
        respondResult(id, {});
        await runPrompt({
          threadId: parsed.data.threadId,
          sessionId: bound.sessionId,
          input: parsed.data.input,
          options: parsed.data.options,
          clientRequestId: parsed.data.clientRequestId,
        });
      } catch (error) {
        emitDeltas(parsed.data.threadId, [
          {
            kind: "turn.boundary",
            status: "error",
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          },
        ]);
      }
    })();
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "Invalid params for turn/steer",
        parsed.error.issues,
      );
      return;
    }
    respondError(id, -32601, "Method not found: turn/steer");
  },

  [BRIDGE_REQUEST_METHODS.skillsConfigure]: (id, params) => {
    const parsed = skillsConfigureParamsSchema.safeParse(params);
    if (!parsed.success) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "Invalid params for skills/configure",
        parsed.error.issues,
      );
      return;
    }
    configuredSkillRoots = parsed.data.roots as SkillConfigureRoot[];
    respondResult(id, { ok: true });
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "Invalid params for thread/stop",
        parsed.error.issues,
      );
      return;
    }
    void (async () => {
      try {
        if (parsed.data.intent === "interrupt") {
          const active = await ensureClient();
          const live = liveTurns.get(parsed.data.threadId);
          const ids = new Set<string>([parsed.data.providerThreadId]);
          if (live) {
            for (const childId of live.liveChildIds) ids.add(childId);
            try {
              const children = await active.sessionChildren(
                parsed.data.providerThreadId,
              );
              for (const child of children) ids.add(child.id);
            } catch {
              /* listed children are best-effort */
            }
          }
          for (const sessionId of ids) {
            try {
              await active.abort(sessionId);
            } catch {
              /* already idle */
            }
          }
          if (live && !live.parentBoundaryEmitted) {
            live.parentBoundaryEmitted = true;
            emitDeltas(parsed.data.threadId, [
              { kind: "turn.boundary", status: "interrupted" },
            ]);
            liveTurns.delete(parsed.data.threadId);
          }
        }
        respondResult(id, {});
      } catch (error) {
        respondError(
          id,
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  },
};

async function settleIssuedTurn(
  threadId: string,
  sessionId: string,
  active: OpenCodeClient,
): Promise<void> {
  const liveAfter = liveTurns.get(threadId);
  if (!liveAfter || liveAfter.parentBoundaryEmitted) return;
  const messages = (await active.sessionMessages(sessionId)) as HydrateMessage[];
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.info.role === "assistant");
  const text =
    lastAssistant?.parts
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text ?? "")
      .join("") ?? "";
  if (text) {
    emitDeltas(threadId, [
      {
        kind: "item.textDelta",
        key: { channel: "final" },
        channel: "agentMessage",
        text,
      },
      {
        kind: "item.textClose",
        key: { channel: "final" },
        channel: "agentMessage",
        text,
      },
    ]);
  }
  liveAfter.parentBoundaryEmitted = true;
  liveTurns.delete(threadId);
  emitDeltas(threadId, [{ kind: "turn.boundary", status: "completed" }]);
}

async function runPrompt(args: {
  threadId: string;
  sessionId: string;
  input: readonly PromptInput[];
  options: unknown;
  clientRequestId?: string;
}): Promise<void> {
  const active = await ensureClient();
  const options = providerOptions(args.options);
  const requested =
    typeof options.agent === "string" ? options.agent : undefined;
  const resolved = await resolveSelectableAgent({
    active,
    requested,
    sessionId: args.sessionId,
  });
  if (!resolved.ok) {
    emitDeltas(args.threadId, [
      {
        kind: "turn.boundary",
        status: "error",
        error: { message: resolved.reason },
      },
    ]);
    return;
  }
  const built = buildPrompt({
    agent: resolved.agent,
    input: args.input,
    model: typeof (args.options as { model?: unknown })?.model === "string"
      ? ((args.options as { model: string }).model as string)
      : undefined,
  });
  if (!built.ok) {
    emitDeltas(args.threadId, [
      {
        kind: "turn.boundary",
        status: "error",
        error: { message: built.reason },
      },
    ]);
    return;
  }

  const existing = liveTurns.get(args.threadId);
  if (existing?.promptIssued) {
    return;
  }
  const live: LiveTurn = {
    threadId: args.threadId,
    sessionId: args.sessionId,
    promptIssued: true,
    mapState: createMapDeltaState(),
    textBuffers: new Map(),
    parentBoundaryEmitted: false,
    liveChildIds: new Set(),
  };
  liveTurns.set(args.threadId, live);
  const deltas: ThreadDelta[] = [];
  if (args.clientRequestId) {
    deltas.push({
      kind: "input.accepted",
      clientRequestId: args.clientRequestId,
    });
  }
  deltas.push({ kind: "turn.open" });
  emitDeltas(args.threadId, deltas);
  try {
    const slash = parseLeadingSlash(firstTextPart(args.input));
    if (slash && !hasNonTextParts(args.input)) {
      const cwd = sessions.get(args.threadId)?.cwd;
      const listed = await active.listCommands(cwd);
      const matched = matchListedCommand(slash.name, listed);
      if (matched) {
        await active.sessionCommand(args.sessionId, {
          command: matched.name,
          arguments: slash.arguments,
          agent: built.prompt.agent,
        });
        await settleIssuedTurn(args.threadId, args.sessionId, active);
        return;
      }
    }
    const appendix = formatSkillAppendix(configuredSkillRoots);
    const prompt = appendix
      ? {
          ...built.prompt,
          parts: [
            ...built.prompt.parts,
            { type: "text" as const, text: appendix },
          ],
        }
      : built.prompt;
    await active.prompt(args.sessionId, { ...prompt });
    await settleIssuedTurn(args.threadId, args.sessionId, active);
  } catch (error) {
    live.parentBoundaryEmitted = true;
    liveTurns.delete(args.threadId);
    try {
      await replayHydrate(args.threadId, args.sessionId, active);
    } catch {
      /* restore is best-effort */
    }
    emitDeltas(args.threadId, [
      {
        kind: "turn.boundary",
        status: "error",
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      },
    ]);
  }
}

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return;
  }
  const { id, method, params, result, error } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (typeof method !== "string") {
    if (typeof id === "string" && pendingPermission.has(id)) {
      const pending = pendingPermission.get(id);
      pendingPermission.delete(id);
      if (pending && result && typeof result === "object") {
        const decision = (result as { decision?: unknown }).decision;
        const reply =
          typeof decision === "string" ? decisionToReply(decision) : undefined;
        if (reply && client) {
          void client
            .replyPermission({
              requestID: pending.requestId,
              sessionID: pending.sessionId,
              reply,
            })
            .catch(() => {
              /* fail closed */
            });
        }
      }
    }
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return;
  }
  const handler = handlers[method];
  if (!handler) {
    respondError(id, -32601, `Method not found: ${method}`);
    return;
  }
  handler(id, params);
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    dataDir = context.dataDir;
  },
});


