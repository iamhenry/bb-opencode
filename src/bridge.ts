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
  threadForkParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { createSdkClient, type OpenCodeClient } from "./client.js";
import { shouldPublishOpenCodeTitle } from "./session-title.js";
import { taskChildSessionId } from "./task-child.js";
import { configDefaultModelId } from "./catalog.js";
import {
  isCompactRequest,
  isCompactionSkipError,
  isOpenCodeCompactCommand,
} from "./compaction.js";
import { splitModelRef } from "./task-thread.js";
import {
  parseOpenCodeTodos,
  todoPlanDeltas,
  todoSnapshotKey,
} from "./todos.js";
import {
  assistantsAfterLastUser,
  completedTurnBoundary,
  filterMessagesByRevertPoint,
  hydrateDeltas,
  lastUserAgent,
  revertMessageIdOf,
  type HydrateMessage,
} from "./hydrate.js";
import {
  closeOpenedItems,
  closeText,
  createMapDeltaState,
  formatUnknownTally,
  mapPartDelta,
  mapSessionNextEvent,
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
  unwrapPermissionAsk,
} from "./permissions/map.js";
import {
  rememberModelWindows,
  usageDeltasFromMessages,
} from "./usage.js";
import {
  answersForOpenCode,
  isQuestionAskEvent,
  toUserQuestionPayload,
  unwrapQuestionAsk,
  type BbUserQuestionPayload,
} from "./questions.js";
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
  defaultReasoningEffortFor,
  openCodeVariantFor,
  reasoningLevelOf,
  supportedReasoningEffortsForModel,
} from "./reasoning.js";
import {
  resolvePermissionAttach,
} from "./permissions/target.js";
import {
  hydratePickerAgent,
  listSelectablePrimaries,
  type OpenCodeAgent,
} from "./selectable-primaries.js";
import {
  isVersionInWindow,
  SERVER_VERSION_MIN,
  versionSkewMessage,
} from "./identity.js";

type JsonRpcId = string | number;

export interface BridgeDeps {
  acquire(url: string): OpenCodeClient;
  attach(dataDir: string): Promise<{ url: string; pid: number; port: number }>;
  write(message: Record<string, unknown>): void;
  now?: () => number;
}

interface ChildWork {
  parentItemId: string;
  mapState: MapDeltaState;
  turnOpened: boolean;
}

interface LiveTurn {
  threadId: string;
  sessionId: string;
  promptIssued: boolean;
  mapState: MapDeltaState;
  textBuffers: Map<string, string>;
  parentBoundaryEmitted: boolean;
  liveChildIds: Set<string>;
  childWork: Map<string, ChildWork>;
  pendingPrompts: Array<Record<string, unknown>>;
}

interface BoundSession {
  threadId: string;
  sessionId: string;
  cwd: string;
  permissionMode?: string;
  instructions?: string;
  disallowedTools: string[];
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
const pendingQuestion = new Map<
  string,
  {
    requestId: string;
    sessionId: string;
    threadId: string;
    payload: BbUserQuestionPayload;
  }
>();

let dataDir = "";
let client: OpenCodeClient | undefined;
let subscribed = false;
let createCount = 0;
let unknownLogLines: string[] = [];
let titleTimer: ReturnType<typeof setInterval> | undefined;
const lastTitles = new Map<string, string>();
const lastRevertCursors = new Map<string, string | null>();
const lastTodos = new Map<string, string>();
const compactIssued = new Set<string>();
const compactInFlight = new Set<string>();
const modelContextWindows = new Map<string, number>();
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
  pendingQuestion.clear();
  configuredSkillRoots = [];
  lastTitles.clear();
  lastRevertCursors.clear();
  lastTodos.clear();
  compactIssued.clear();
  compactInFlight.clear();
  modelContextWindows.clear();
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
  void ensureSubscribed(client);
  return client;
}

function failLiveTurns(message: string): void {
  for (const [threadId, live] of liveTurns) {
    if (live.parentBoundaryEmitted) continue;
    live.parentBoundaryEmitted = true;
    emitDeltas(threadId, [
      {
        kind: "turn.boundary",
        status: "failed",
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

function requireSessionId(sessionId: string | undefined, action: string): string {
  if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  throw new Error(`OpenCode ${action} returned no session id`);
}

function bindSession(threadId: string, session: BoundSession): void {
  requireSessionId(session.sessionId, "bind");
  sessions.set(threadId, session);
  sessionToThread.set(session.sessionId, threadId);
  if (!lastRevertCursors.has(session.sessionId)) {
    lastRevertCursors.set(session.sessionId, null);
  }
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
      [...sessionToThread.keys()].map(async (sessionId) => {
        await syncSessionTitle(sessionId);
        await syncPendingPermissions(sessionId);
        await syncPendingQuestions(sessionId);
        await syncLiveTurnParts(sessionId);
        await syncSessionRevert(sessionId);
        await syncSessionTodos(sessionId);
      }),
    );
  }, 800);
  titleTimer.unref?.();
}

export async function syncLiveTurnParts(sessionId: string): Promise<boolean> {
  if (!client) return false;
  const threadId = sessionToThread.get(sessionId);
  if (!threadId) return false;
  const live = liveTurns.get(threadId);
  if (!live || live.parentBoundaryEmitted || live.sessionId !== sessionId) {
    return false;
  }
  try {
    const messages = (await client.sessionMessages(sessionId)) as HydrateMessage[];
    const leftovers: ThreadDelta[] = [];
    for (const message of assistantsAfterLastUser(messages)) {
      for (const part of message.parts) {
        rememberTaskChild(live, part);
        leftovers.push(
          ...mapPartDelta({
            state: live.mapState,
            part,
            sessionId,
          }),
        );
      }
    }
    try {
      const children = await client.sessionChildren(sessionId);
      for (const child of children) {
        live.liveChildIds.add(child.id);
        if (!live.childWork.has(child.id)) {
          for (const message of messages) {
            for (const part of message.parts) {
              if (taskChildSessionId(part) === child.id) {
                rememberTaskChild(live, part);
              }
            }
          }
        }
        if (!live.childWork.has(child.id)) continue;
        const childMessages = (await client.sessionMessages(
          child.id,
        )) as HydrateMessage[];
        leftovers.push(
          ...projectChildParts(
            live,
            child.id,
            childMessages.flatMap((message) =>
              message.parts.map((part) => part as Record<string, unknown>),
            ),
          ),
        );
      }
    } catch {
      /* children are best-effort; parent leftovers still apply */
    }
    if (leftovers.length === 0) return false;
    emitDeltas(threadId, leftovers);
    return true;
  } catch {
    return false;
  }
}

export async function syncSessionRevert(sessionId: string): Promise<boolean> {
  if (!client) return false;
  const threadId = sessionToThread.get(sessionId);
  if (!threadId) return false;
  try {
    const session = await client.getSession(sessionId);
    const cursor = revertMessageIdOf(session) ?? null;
    if (lastRevertCursors.get(sessionId) === cursor) return false;
    lastRevertCursors.set(sessionId, cursor);
    await replayHydrate(threadId, sessionId, client);
    return true;
  } catch {
    return false;
  }
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
      if (!shouldPublishOpenCodeTitle(title)) return false;
      emitDeltas(threadId, [{ kind: "thread.name", name: title }]);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function syncPendingPermissions(sessionId: string): Promise<void> {
  if (!client) return;
  const threadId = sessionToThread.get(sessionId);
  if (!threadId) return;
  const live = liveTurns.get(threadId);
  if (!live || live.parentBoundaryEmitted) return;
  try {
    const pending = await client.listPendingPermissions(sessionId);
    for (const ask of pending) {
      await handlePermissionAsked(ask, sessionId);
    }
  } catch {
    /* list is best-effort; SSE remains the primary path */
  }
}

async function syncPendingQuestions(sessionId: string): Promise<void> {
  if (!client) return;
  const threadId = sessionToThread.get(sessionId);
  if (!threadId) return;
  const live = liveTurns.get(threadId);
  if (!live || live.parentBoundaryEmitted) return;
  try {
    const pending = await client.listPendingQuestions(sessionId);
    for (const ask of pending) {
      await handleQuestionAsked(ask, sessionId);
    }
  } catch {
    /* list is best-effort; SSE remains the primary path */
  }
}

export async function syncSessionTodos(sessionId: string): Promise<boolean> {
  if (!client) return false;
  const threadId = sessionToThread.get(sessionId);
  if (!threadId) return false;
  try {
    const todos = parseOpenCodeTodos(await client.sessionTodos(sessionId));
    const key = todoSnapshotKey(todos);
    if (lastTodos.get(sessionId) === key) return false;
    lastTodos.set(sessionId, key);
    emitDeltas(threadId, todoPlanDeltas(todos) as ThreadDelta[]);
    return true;
  } catch {
    return false;
  }
}

export async function hydrateBoundSession(sessionId: string): Promise<boolean> {
  const threadId = sessionToThread.get(sessionId);
  if (!threadId || !client) return false;
  await replayHydrate(threadId, sessionId, client);
  return true;
}

function steerDeliveryOf(options: unknown): "inject" | "queue" {
  const value = providerOptions(options).steerDelivery;
  return value === "inject" ? "inject" : "queue";
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

function instructionsOf(options: unknown): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const value = (options as { instructions?: unknown }).instructions;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function disallowedToolsOf(params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  const value = (params as { disallowedTools?: unknown }).disallowedTools;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function sessionPolicy(params: unknown): Pick<
  BoundSession,
  "instructions" | "disallowedTools"
> {
  return {
    instructions: instructionsOf(
      params && typeof params === "object"
        ? (params as { options?: unknown }).options
        : undefined,
    ),
    disallowedTools: disallowedToolsOf(params),
  };
}

async function replayHydrate(
  threadId: string,
  sessionId: string,
  active: OpenCodeClient,
): Promise<void> {
  const session = await active.getSession(sessionId);
  const cursor = revertMessageIdOf(session) ?? null;
  lastRevertCursors.set(sessionId, cursor);
  const messages = filterMessagesByRevertPoint(
    (await active.sessionMessages(sessionId)) as HydrateMessage[],
    cursor ?? undefined,
  );
  await rememberCatalogWindows(active);
  emitDeltas(threadId, [
    ...hydrateDeltas({ sessionId, messages }),
    ...usageDeltasFromMessages(messages, modelContextWindows),
  ]);
  try {
    const todos = parseOpenCodeTodos(await active.sessionTodos(sessionId));
    lastTodos.set(sessionId, todoSnapshotKey(todos));
    emitDeltas(threadId, todoPlanDeltas(todos) as ThreadDelta[]);
  } catch {
    /* todos are best-effort */
  }
}

function attachObservedTurn(threadId: string, sessionId: string): void {
  if (liveTurns.has(threadId)) return;
  liveTurns.set(threadId, {
    threadId,
    sessionId,
    promptIssued: false,
    mapState: createMapDeltaState(),
    textBuffers: new Map(),
    parentBoundaryEmitted: false,
    liveChildIds: new Set(),
    childWork: new Map(),
    pendingPrompts: [],
  });
  emitDeltas(threadId, [{ kind: "turn.open" }]);
}

async function finishBindOnlyStart(args: {
  threadId: string;
  sessionId: string;
  active: OpenCodeClient;
}): Promise<void> {
  const running = await args.active.sessionIsRunning(args.sessionId);
  if (running) {
    attachObservedTurn(args.threadId, args.sessionId);
    return;
  }
  emitDeltas(args.threadId, [
    { kind: "turn.open" },
    completedTurnBoundary(),
  ]);
}

async function rememberCatalogWindows(active: OpenCodeClient): Promise<void> {
  if (modelContextWindows.size > 0) return;
  try {
    const catalog = await active.providers();
    rememberModelWindows(modelContextWindows, catalog.providers ?? []);
  } catch {
    /* size stays unknown; meter still gets used tokens */
  }
}

function eventSessionId(event: { type: string; properties?: unknown }): string | undefined {
  const properties = event.properties;
  if (!properties || typeof properties !== "object") return undefined;
  const record = properties as Record<string, unknown>;
  if (typeof record.sessionID === "string") return record.sessionID;
  const unwrapped = unwrapPermissionAsk(record);
  if (
    unwrapped &&
    typeof unwrapped === "object" &&
    typeof (unwrapped as { sessionID?: unknown }).sessionID === "string"
  ) {
    return (unwrapped as { sessionID: string }).sessionID;
  }
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
  const resolved = resolveLiveTurn(sessionId, event.properties);
  const threadId = resolved?.threadId ?? sessionToThread.get(sessionId);
  const live = resolved?.live ?? (threadId ? liveTurns.get(threadId) : undefined);
  const childId = resolved?.childId;

  if (isQuestionAskEvent(event.type)) {
    await handleQuestionAsked(event.properties, sessionId);
    return;
  }
  if (isPermissionAskEvent(event.type)) {
    await handlePermissionAsked(event.properties, sessionId);
    return;
  }

  if (event.type === "todo.updated") {
    const bound = sessionToThread.get(sessionId);
    if (!bound) return;
    const todos = parseOpenCodeTodos(
      event.properties && typeof event.properties === "object"
        ? (event.properties as { todos?: unknown }).todos
        : event.properties,
    );
    const key = todoSnapshotKey(todos);
    if (lastTodos.get(sessionId) === key) return;
    lastTodos.set(sessionId, key);
    emitDeltas(bound, todoPlanDeltas(todos) as ThreadDelta[]);
    return;
  }

  if (event.type === "session.compacted") {
    const bound = sessionToThread.get(sessionId);
    if (!bound) return;
    if (compactIssued.has(sessionId) || compactInFlight.has(sessionId)) {
      compactIssued.delete(sessionId);
      return;
    }
    emitDeltas(bound, [{ kind: "context.compacted" }]);
    if (!liveTurns.get(bound)?.promptIssued) {
      try {
        if (client) await replayHydrate(bound, sessionId, client);
      } catch {
        /* hydrate is best-effort after OpenCode auto-compact */
      }
    }
    return;
  }

  if (event.type === "session.updated" || event.type === "session.diff") {
    if (childId) return;
    const title = sessionTitle(event.properties);
    if (title && threadId) {
      lastTitles.set(sessionId, title);
      if (shouldPublishOpenCodeTitle(title)) {
        emitDeltas(threadId, [{ kind: "thread.name", name: title }]);
      }
    } else {
      void syncSessionTitle(sessionId);
    }
    void syncSessionRevert(sessionId);
    return;
  }

  if (!threadId || !live) {
    if (threadId && event.type) {
      unknownLogLines.push(`unknown-events session=${sessionId} ${event.type}=1`);
    }
    return;
  }

  if (childId || sessionId !== live.sessionId) {
    const id = childId ?? sessionId;
    const parentId = eventParentId(event.properties);
    if (parentId === live.sessionId) live.liveChildIds.add(id);
    if (event.type === "session.idle" || event.type === "session.status") {
      live.liveChildIds.delete(id);
      return;
    }
    if (event.type.startsWith("session.next.")) {
      const work = live.childWork.get(id);
      if (!work) return;
      const nextDeltas = mapSessionNextEvent({
        type: event.type,
        properties: event.properties,
        state: work.mapState,
        sessionId: id,
        parentRef: work.parentItemId,
      });
      if (nextDeltas.length > 0) emitDeltas(threadId, nextDeltas);
      return;
    }
    if (event.type === "message.part.delta" || event.type === "message.part.updated") {
      const record =
        event.properties && typeof event.properties === "object"
          ? (event.properties as { part?: Record<string, unknown> })
          : undefined;
      const part = record?.part ?? record;
      if (part && typeof part === "object" && "type" in part) {
        const nested = projectChildParts(live, id, [
          part as Record<string, unknown>,
        ]);
        if (nested.length > 0) emitDeltas(threadId, nested);
      }
    }
    return;
  }

  if (event.type === "message.updated") {
    const info =
      event.properties && typeof event.properties === "object"
        ? (event.properties as { info?: unknown }).info
        : undefined;
    const usage = usageDeltasFromMessages(
      [{ info }],
      modelContextWindows,
      "open",
    );
    if (usage.length > 0) emitDeltas(threadId, usage);
    return;
  }

  if (event.type.startsWith("session.next.")) {
    const nextDeltas = mapSessionNextEvent({
      type: event.type,
      properties: event.properties,
      state: live.mapState,
      sessionId,
    });
    if (nextDeltas.length > 0) emitDeltas(threadId, nextDeltas);
    return;
  }

  if (event.type === "message.part.delta" || event.type === "message.part.updated") {
    const record =
      event.properties && typeof event.properties === "object"
        ? (event.properties as { part?: Record<string, unknown>; delta?: unknown })
        : undefined;
    const part = record?.part ?? record;
    const delta = typeof record?.delta === "string" ? record.delta : undefined;
    if (part && typeof part === "object" && "type" in part) {
      rememberTaskChild(live, part as { id?: string; tool?: string; callID?: string; state?: { sessionID?: unknown; sessionId?: unknown; input?: Record<string, unknown>; metadata?: Record<string, unknown> } });
      emitDeltas(
        threadId,
        mapPartDelta({
          state: live.mapState,
          part,
          sessionId,
          delta,
        }),
      );
      const typed = part as { id?: string; type?: string; text?: string };
      if (typed.type === "text" && typed.id) {
        const latest =
          live.mapState.emittedText.get(typed.id) ?? typed.text ?? "";
        if (latest) live.textBuffers.set(typed.id, latest);
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
    if (live.promptIssued && !live.parentBoundaryEmitted) {
      /* POST /message is still the source of truth; idle must not
         close the turn before settle can flush tool/text leftovers. */
      return;
    }
    if (!live.parentBoundaryEmitted) {
      live.parentBoundaryEmitted = true;
      for (const [id, text] of live.textBuffers) {
        emitDeltas(threadId, closeText(id, text));
      }
      emitDeltas(threadId, [completedTurnBoundary()]);
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
          status: "failed",
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

function rememberTaskChild(
  live: LiveTurn,
  part: {
    id?: string;
    tool?: string;
    callID?: string;
    state?: {
      sessionID?: unknown;
      sessionId?: unknown;
      input?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
  },
): ChildWork | undefined {
  const childId = taskChildSessionId(part);
  const parentItemId = part.id ?? part.callID;
  if (!childId || !parentItemId) return undefined;
  live.liveChildIds.add(childId);
  const existing = live.childWork.get(childId);
  if (existing) return existing;
  const work: ChildWork = {
    parentItemId,
    mapState: createMapDeltaState(),
    turnOpened: false,
  };
  live.childWork.set(childId, work);
  return work;
}

function projectChildParts(
  live: LiveTurn,
  childId: string,
  parts: Array<Record<string, unknown>>,
): ThreadDelta[] {
  const work = live.childWork.get(childId);
  if (!work) return [];
  const deltas: ThreadDelta[] = [];
  if (!work.turnOpened) {
    work.turnOpened = true;
    deltas.push({
      kind: "turn.open",
      providerTurnId: childId,
      parentRef: work.parentItemId,
    });
  }
  for (const part of parts) {
    deltas.push(
      ...mapPartDelta({
        state: work.mapState,
        part,
        sessionId: childId,
        parentRef: work.parentItemId,
      }),
    );
  }
  return deltas;
}

function resolveLiveTurn(
  sessionId: string,
  properties?: unknown,
): { threadId: string; live: LiveTurn; childId?: string } | undefined {
  const bound = sessionToThread.get(sessionId);
  if (bound) {
    const live = liveTurns.get(bound);
    if (live) {
      return {
        threadId: bound,
        live,
        childId: sessionId === live.sessionId ? undefined : sessionId,
      };
    }
  }
  const parentId = eventParentId(properties);
  if (parentId) {
    const threadId = sessionToThread.get(parentId);
    const live = threadId ? liveTurns.get(threadId) : undefined;
    if (threadId && live && live.sessionId === parentId) {
      live.liveChildIds.add(sessionId);
      return { threadId, live, childId: sessionId };
    }
  }
  for (const [threadId, live] of liveTurns) {
    if (live.childWork.has(sessionId) || live.liveChildIds.has(sessionId)) {
      return { threadId, live, childId: sessionId };
    }
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

async function denyPermissionAsk(args: {
  active: OpenCodeClient;
  requestId?: string;
  sessionId: string;
  threadId: string;
  reason: string;
}): Promise<void> {
  if (args.requestId) {
    try {
      await args.active.replyPermission({
        requestID: args.requestId,
        sessionID: args.sessionId,
        reply: "reject",
      });
    } catch {
      /* already settled */
    }
  }
  const denyKey = {
    providerItemId: `perm-deny-${args.requestId ?? "unknown"}`,
  };
  const denyPresentation = {
    label: { pending: "Permission denied", completed: "Permission denied" },
    icon: { glyph: "ShieldOff" },
    detail: args.reason.slice(0, 280),
  };
  emitDeltas(args.threadId, [
    {
      kind: "item.open",
      key: denyKey,
      item: { type: "tool", tool: "permission" },
      presentation: denyPresentation,
    },
    {
      kind: "item.close",
      key: denyKey,
      status: "failed",
      item: {
        type: "tool",
        tool: "permission",
        error: args.reason,
      },
      presentation: denyPresentation,
    },
  ]);
}

async function handleQuestionAsked(
  raw: unknown,
  fallbackSessionId: string,
): Promise<void> {
  const ask = unwrapQuestionAsk(raw);
  const sessionId = ask?.sessionID ?? fallbackSessionId;
  const threadId = sessionToThread.get(sessionId);
  const live = threadId ? liveTurns.get(threadId) : undefined;
  const requestId = ask?.id;
  const payload = ask ? toUserQuestionPayload(ask) : undefined;
  if (!threadId || !live || !requestId || !payload || !client) {
    if (client && requestId) {
      await client.rejectQuestion({ requestID: requestId, sessionID: sessionId }).catch(() => undefined);
    }
    return;
  }
  const existing = `oc-q-${requestId}`;
  if (pendingQuestion.has(existing)) return;
  pendingQuestion.set(existing, {
    requestId,
    sessionId,
    threadId,
    payload,
  });
  deps.write({
    id: existing,
    method: BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
    params: {
      providerThreadId: sessionId,
      threadId,
      turnId: null,
      providerNativeIds: true,
      payload,
    },
  });
}

async function rejectPendingQuestions(threadId: string): Promise<void> {
  const active = client;
  for (const [key, pending] of [...pendingQuestion]) {
    if (pending.threadId !== threadId) continue;
    pendingQuestion.delete(key);
    if (!active) continue;
    try {
      await active.rejectQuestion({
        requestID: pending.requestId,
        sessionID: pending.sessionId,
      });
    } catch {
      /* fail closed */
    }
  }
}

async function rejectPendingPermissions(threadId: string): Promise<void> {
  await rejectPendingQuestions(threadId);
  const active = client;
  for (const [key, pending] of [...pendingPermission]) {
    if (pending.threadId !== threadId) continue;
    pendingPermission.delete(key);
    if (!active) continue;
    try {
      await active.replyPermission({
        requestID: pending.requestId,
        sessionID: pending.sessionId,
        reply: "reject",
      });
    } catch {
      /* already settled */
    }
  }
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
  if (attach.action === "drop") {
    if (typeof mapped.requestId === "string") {
      try {
        await active.replyPermission({
          requestID: mapped.requestId,
          sessionID: sessionId,
          reply: "reject",
        });
      } catch {
        /* already settled */
      }
    }
    return;
  }
  const targetThreadId = attach.threadId;
  if (parentLive && parentSessionId) {
    parentLive.liveChildIds.add(sessionId);
  }

  const live = liveTurns.get(targetThreadId);
  const permissionMode = sessions.get(targetThreadId)?.permissionMode;

  if (mapped.requestId) {
    const existing = `oc-perm-${mapped.requestId}`;
    if (pendingPermission.has(existing)) return;
  }
  if (mapped.tag === "unknown" || !mapped.requestId || !mapped.subject) {
    await denyPermissionAsk({
      active,
      requestId: mapped.requestId,
      sessionId,
      threadId: targetThreadId,
      reason: mapped.reason ?? "unmappable permission ask",
    });
    return;
  }
  const blocked = sessions.get(targetThreadId)?.disallowedTools ?? [];
  const permissionName = (mapped.permission ?? "").toLowerCase();
  const toolName =
    mapped.subject?.kind === "tool_use"
      ? mapped.subject.tool.toLowerCase()
      : "";
  if (
    blocked.some((name) => {
      const needle = name.toLowerCase();
      return needle === permissionName || needle === toolName;
    })
  ) {
    await denyPermissionAsk({
      active,
      requestId: mapped.requestId,
      sessionId,
      threadId: targetThreadId,
      reason: `BB disallowed tool: ${mapped.permission ?? toolName}`,
    });
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
  if (!shouldShowCard({ tag: mapped.tag, permissionMode }) || !live) {
    await denyPermissionAsk({
      active,
      requestId: mapped.requestId,
      sessionId,
      threadId: targetThreadId,
      reason: !live
        ? "permission ask arrived with no live turn"
        : "permission ask not shown",
    });
    return;
  }

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
        fork: "checkpoint",
        approvalEnforcedBy: "provider",
        steerMode: "queue",
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.experimentalProviderHealth]: (id) => {
    void (async () => {
      try {
        const active = await ensureClient();
        const health = await active.health();
        const ready = isVersionInWindow(health.version);
        respondResult(id, {
          supported: true,
          health: {
            status: ready ? "ready" : "unsupported_version",
            statusMessage: ready ? null : versionSkewMessage(health.version),
            accountEmail: null,
            planLabel: null,
            installedVersion: health.version,
            minimumSupportedVersion: SERVER_VERSION_MIN,
            canInstall: false,
            canUpdate: false,
            loginCommand: null,
          },
        });
      } catch (error) {
        respondResult(id, {
          supported: true,
          health: {
            status: "unknown",
            statusMessage:
              error instanceof Error ? error.message : String(error),
            accountEmail: null,
            planLabel: null,
            installedVersion: null,
            minimumSupportedVersion: SERVER_VERSION_MIN,
            canInstall: false,
            canUpdate: false,
            loginCommand: null,
          },
        });
      }
    })();
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
        rememberModelWindows(modelContextWindows, catalog.providers ?? []);
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
              const supportedReasoningEfforts =
                supportedReasoningEffortsForModel(raw);
              return {
                id: `${provider.id}/${modelId}`,
                model: modelId,
                displayName: formatModelDisplayName(
                  provider.id,
                  raw?.name ?? modelId,
                ),
                description: provider.id,
                supportedReasoningEfforts,
                defaultReasoningEffort: defaultReasoningEffortFor(
                  supportedReasoningEfforts,
                ),
                isDefault: false,
              };
            },
          );
        });
        let configured: string | undefined;
        try {
          configured = configDefaultModelId(await active.getConfig());
        } catch {
          configured = undefined;
        }
        const preferred =
          models.find((model) => model.id === configured) ??
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
          sessionId = requireSessionId(created.id, "session.create");
        }
        const bound: BoundSession = {
          threadId: parsed.data.threadId,
          sessionId,
          cwd: parsed.data.cwd,
          permissionMode: permissionModeOf(parsed.data.options),
          ...sessionPolicy(parsed.data),
        };
        bindSession(parsed.data.threadId, bound);
        emitDeltas(parsed.data.threadId, [{ kind: "session.reset" }]);
        respondResult(id, { providerThreadId: sessionId });
        if (adoptId) {
          await replayHydrate(parsed.data.threadId, sessionId, active);
        }
        if (options.bindOnly === true) {
          await finishBindOnlyStart({
            threadId: parsed.data.threadId,
            sessionId,
            active,
          });
          return;
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
          ...sessionPolicy(parsed.data),
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

  [BRIDGE_REQUEST_METHODS.threadFork]: (id, params) => {
    const parsed = threadForkParamsSchema.safeParse(params);
    if (!parsed.success) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "Invalid params for thread/fork",
        parsed.error.issues,
      );
      return;
    }
    void (async () => {
      try {
        const active = await ensureClient();
        const forked = await active.forkSession(
          parsed.data.sourceProviderThreadId,
          parsed.data.sourceProviderCheckpointId
            ? { messageID: parsed.data.sourceProviderCheckpointId }
            : {},
        );
        bindSession(parsed.data.threadId, {
          threadId: parsed.data.threadId,
          sessionId: requireSessionId(forked.id, "session.fork"),
          cwd: parsed.data.cwd,
          permissionMode: permissionModeOf(parsed.data.options),
          ...sessionPolicy(parsed.data),
        });
        respondResult(id, { providerThreadId: forked.id });
        await replayHydrate(parsed.data.threadId, forked.id, active);
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
        Object.assign(bound, sessionPolicy(parsed.data));
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
            status: "failed",
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
    const bound = sessions.get(parsed.data.threadId);
    if (!bound) {
      respondError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "Unknown thread");
      return;
    }
    bound.permissionMode = permissionModeOf(parsed.data.options);
    Object.assign(bound, sessionPolicy(parsed.data));
    /* Ack before delivery. A JSON-RPC error here becomes BB run.failed
       and kills the live turn ("Steer failed"). */
    respondResult(id, {});
    void runSteer({
      threadId: parsed.data.threadId,
      sessionId: bound.sessionId,
      input: parsed.data.input,
      options: parsed.data.options,
      clientRequestId: parsed.data.clientRequestId,
    });
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
          await rejectPendingPermissions(parsed.data.threadId);
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
              ...closeOpenedItems(live.mapState),
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
  const queued = liveAfter.pendingPrompts.shift();
  if (queued) {
    try {
      await active.prompt(sessionId, queued);
      await settleIssuedTurn(threadId, sessionId, active);
    } catch (error) {
      liveAfter.parentBoundaryEmitted = true;
      liveTurns.delete(threadId);
      emitDeltas(threadId, [
        {
          kind: "turn.boundary",
          status: "failed",
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        },
      ]);
    }
    return;
  }
  const messages = (await active.sessionMessages(sessionId)) as HydrateMessage[];
  const leftovers: ThreadDelta[] = [];
  for (const message of assistantsAfterLastUser(messages)) {
    for (const part of message.parts) {
      leftovers.push(
        ...mapPartDelta({
          state: liveAfter.mapState,
          part,
          sessionId,
        }),
      );
      if (part.type === "text" && part.text && part.id) {
        leftovers.push(...closeText(part.id, part.text));
      }
    }
  }
  if (leftovers.length > 0) emitDeltas(threadId, leftovers);
  liveAfter.parentBoundaryEmitted = true;
  liveTurns.delete(threadId);
  await rememberCatalogWindows(active);
  emitDeltas(threadId, [
    completedTurnBoundary(messages),
    ...usageDeltasFromMessages(messages, modelContextWindows),
  ]);
  // Native ensureTitle forks on the first prompt step and may finish after idle.
  await syncSessionTitle(sessionId);
}

async function runSteer(args: {
  threadId: string;
  sessionId: string;
  input: readonly PromptInput[];
  options: unknown;
  clientRequestId?: string;
}): Promise<void> {
  const live = liveTurns.get(args.threadId);
  if (!live || live.parentBoundaryEmitted || live.sessionId !== args.sessionId) {
    await runPrompt(args);
    return;
  }
  const active = await ensureClient();
  const options = providerOptions(args.options);
  const requested =
    typeof options.agent === "string" ? options.agent : undefined;
  const resolved = await resolveSelectableAgent({
    active,
    requested,
    sessionId: args.sessionId,
  });
  if (!resolved.ok) return;
  const built = buildPrompt({
    agent: resolved.agent,
    input: args.input,
    model:
      typeof (args.options as { model?: unknown })?.model === "string"
        ? ((args.options as { model: string }).model as string)
        : undefined,
  });
  if (!built.ok) return;
  if (args.clientRequestId) {
    emitDeltas(args.threadId, [
      { kind: "input.accepted", clientRequestId: args.clientRequestId },
    ]);
  }
  const variant = openCodeVariantFor(reasoningLevelOf(args.options));
  const body = {
    ...built.prompt,
    ...(variant ? { variant } : {}),
  };
  if (steerDeliveryOf(args.options) === "inject") {
    try {
      await active.promptAsync(args.sessionId, body);
    } catch {
      void active.prompt(args.sessionId, body);
    }
    return;
  }
  live.pendingPrompts.push(body);
}

async function resolveCompactModel(
  active: OpenCodeClient,
  options: unknown,
): Promise<{ providerID: string; modelID: string } | null> {
  const model =
    typeof (options as { model?: unknown })?.model === "string"
      ? ((options as { model: string }).model as string)
      : undefined;
  return (
    splitModelRef(model) ??
    splitModelRef(configDefaultModelId(await active.getConfig()))
  );
}

async function runCompact(args: {
  threadId: string;
  sessionId: string;
  options: unknown;
  active: OpenCodeClient;
}): Promise<void> {
  const live = liveTurns.get(args.threadId);
  if (!live) return;
  if (compactInFlight.has(args.sessionId)) {
    live.parentBoundaryEmitted = true;
    liveTurns.delete(args.threadId);
    emitDeltas(args.threadId, [
      {
        kind: "provider.warning",
        category: "compaction-skipped",
        summary: "Context compaction skipped",
        details: "A compact is already running",
        vouchedTurn: true,
      },
      completedTurnBoundary(),
    ]);
    return;
  }
  compactInFlight.add(args.sessionId);
  compactIssued.add(args.sessionId);
  const key = { channel: "compaction" };
  emitDeltas(args.threadId, [
    {
      kind: "item.open",
      key,
      item: { type: "compaction" },
      presentation: {
        label: { pending: "Compacting context", completed: "Compacted context" },
        icon: { glyph: "FoldVertical" },
      },
    },
  ]);
  try {
    const model = await resolveCompactModel(args.active, args.options);
    if (!model) {
      throw new Error("No OpenCode model available to compact");
    }
    await args.active.summarize(args.sessionId, model);
    emitDeltas(args.threadId, [
      {
        kind: "item.close",
        key,
        status: "completed",
        item: { type: "compaction" },
        presentation: {
          label: {
            pending: "Compacting context",
            completed: "Compacted context",
          },
          icon: { glyph: "FoldVertical" },
        },
      },
      { kind: "context.compacted" },
    ]);
    live.parentBoundaryEmitted = true;
    liveTurns.delete(args.threadId);
    emitDeltas(args.threadId, [completedTurnBoundary()]);
    await replayHydrate(args.threadId, args.sessionId, args.active);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isCompactionSkipError(message)) {
      emitDeltas(args.threadId, [
        {
          kind: "provider.warning",
          category: "compaction-skipped",
          summary: "Context compaction skipped",
          details: message,
          vouchedTurn: true,
        },
        {
          kind: "item.close",
          key,
          status: "completed",
          item: { type: "compaction" },
        },
      ]);
      live.parentBoundaryEmitted = true;
      liveTurns.delete(args.threadId);
      emitDeltas(args.threadId, [completedTurnBoundary()]);
      compactIssued.delete(args.sessionId);
      return;
    }
    live.parentBoundaryEmitted = true;
    liveTurns.delete(args.threadId);
    compactIssued.delete(args.sessionId);
    emitDeltas(args.threadId, [
      {
        kind: "item.close",
        key,
        status: "failed",
        item: { type: "compaction" },
      },
      {
        kind: "turn.boundary",
        status: "failed",
        error: { message },
      },
    ]);
  } finally {
    compactInFlight.delete(args.sessionId);
    compactIssued.delete(args.sessionId);
  }
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
        status: "failed",
        error: { message: resolved.reason },
      },
    ]);
    return;
  }
  const bound = sessions.get(args.threadId);
  const built = buildPrompt({
    agent: resolved.agent,
    input: args.input,
    model: typeof (args.options as { model?: unknown })?.model === "string"
      ? ((args.options as { model: string }).model as string)
      : undefined,
    instructions:
      bound?.instructions ?? instructionsOf(args.options),
  });
  if (!built.ok) {
    emitDeltas(args.threadId, [
      {
        kind: "turn.boundary",
        status: "failed",
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
    childWork: new Map(),
    pendingPrompts: [],
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
    if (isCompactRequest(args.input)) {
      await runCompact({
        threadId: args.threadId,
        sessionId: args.sessionId,
        options: args.options,
        active,
      });
      return;
    }
    compactIssued.delete(args.sessionId);
    if (slash && !hasNonTextParts(args.input)) {
      const cwd = sessions.get(args.threadId)?.cwd;
      const listed = await active.listCommands(cwd);
      const matched = matchListedCommand(slash.name, listed);
      if (matched && !isOpenCodeCompactCommand(matched.name)) {
        const variant = openCodeVariantFor(reasoningLevelOf(args.options));
        await active.sessionCommand(args.sessionId, {
          command: matched.name,
          arguments: slash.arguments,
          agent: built.prompt.agent,
          ...(variant ? { variant } : {}),
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
    const variant = openCodeVariantFor(reasoningLevelOf(args.options));
    await active.prompt(args.sessionId, {
      ...prompt,
      ...(variant ? { variant } : {}),
    });
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
        status: "failed",
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
    if (typeof id === "string" && pendingQuestion.has(id)) {
      const pending = pendingQuestion.get(id);
      pendingQuestion.delete(id);
      if (pending && client) {
        const resolution =
          result && typeof result === "object"
            ? (result as {
                kind?: unknown;
                answers?: Record<string, { selected?: string[]; freeText?: string }>;
              })
            : undefined;
        if (resolution?.kind === "user_answer") {
          void client
            .replyQuestion({
              requestID: pending.requestId,
              sessionID: pending.sessionId,
              answers: answersForOpenCode(pending.payload, resolution),
            })
            .catch(() => undefined);
        } else {
          void client
            .rejectQuestion({
              requestID: pending.requestId,
              sessionID: pending.sessionId,
            })
            .catch(() => undefined);
        }
      }
      return;
    }
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


