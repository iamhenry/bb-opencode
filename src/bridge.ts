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
  threadNameSetParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { createSdkClient, type OpenCodeClient } from "./client.js";
import { debugLog, recentDebugLog, resetDebugLogForTests } from "./debug-log.js";
import { OrderedEventPump } from "./event-pump.js";
import { readCompleteHistory } from "./history-pages.js";
import {
  firstVisibleUserText,
  greetingSessionTitle,
  shouldPublishOpenCodeTitle,
} from "./session-title.js";
import { taskChildPrompt, taskChildSessionId } from "./task-child.js";
import { noteLiveTaskChild } from "./task-live.js";
import {
  coerceModelRef,
  configDefaultModelId,
  lastModelIdFromMessages,
  lastVariantFromMessages,
  listPickerModels,
} from "./catalog.js";
import {
  isCompactRequest,
  isCompactionSkipError,
  isOpenCodeCompactCommand,
} from "./compaction.js";
import { splitModelRef, TASK_CHILD_BIND_TEXT } from "./task-thread.js";
import {
  parseOpenCodeTodos,
  todoPlanDeltas,
  todoSnapshotKey,
} from "./todos.js";
import {
  describeSessionError,
  readSessionStatus,
  retryFromPart,
  retryKey,
} from "./session-status.js";
import {
  nextUncardedWriteStreak,
  runningFileToolName,
} from "./uncarded-write.js";
import {
  assistantsAfterLastUser,
  completedTurnBoundary,
  filterMessagesByRevertPoint,
  hydrateDeltas,
  lastAssistantSettled,
  lastUserAgent,
  lastUserMessageId,
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
  openCommandItem,
  resolveAgentTextChannel,
  sealOpenTextChannel,
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
  isQuestionToolName,
  toUserQuestionPayload,
  unwrapQuestionAsk,
  type BbUserQuestionPayload,
} from "./questions.js";
import { attachOrSpawn, isAbortTimeout } from "./process.js";
import { buildPrompt } from "./prompt-builder.js";
import { formatSkillAppendix, type SkillConfigureRoot } from "./skill-appendix.js";
import {
  firstTextPart,
  hasNonTextParts,
  matchListedCommand,
  parseLeadingSlash,
} from "./slash-command.js";
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
  clearLivePermissionModes,
  readLivePermissionMode,
} from "./permission-mode-live.js";
import {
  resolveContinueAgent,
  type OpenCodeAgent,
} from "./selectable-primaries.js";
import {
  isVersionInWindow,
  SERVER_VERSION_MIN,
  versionSkewMessage,
} from "./identity.js";

type JsonRpcId = string | number;

const PROMPT_HISTORY_LIMIT = 100;
/** SSE is authoritative; polling only reconciles a bounded recent tail. */
const RECONCILE_HISTORY_LIMIT = 150;
const TITLE_HISTORY_LIMIT = 50;

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

interface SteerRestart {
  expectAbortError: boolean;
  expectAbortIdle: boolean;
  promptStarted: boolean;
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
  retryWarned: Set<string>;
  userMessageIds: Set<string>;
  bindOnly?: boolean;
  /** The user message for the prompt currently owned by this BB turn. */
  pollUserMessageId?: string;
  settling?: boolean;
  stopping?: boolean;
  steerRestart?: SteerRestart;
}

interface BoundSession {
  threadId: string;
  sessionId: string;
  cwd: string;
  bindOnly?: boolean;
  permissionMode?: string;
  instructions?: string;
  disallowedTools: string[];
  lastSnapshot?: unknown;
}

const sessions = new Map<string, BoundSession>();
const sessionToThread = new Map<string, string>();
const liveTurns = new Map<string, LiveTurn>();
const openingTurns = new Set<string>();
const parkedSteers = new Map<string, Array<Record<string, unknown>>>();
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
    status: "pending" | "answering" | "settled";
  }
>();

let dataDir = "";
let client: OpenCodeClient | undefined;
const subscriptions = new Map<string, { unsubscribe(): void }>();
let createCount = 0;
let unknownLogLines: string[] = [];
let titleTimer: ReturnType<typeof setInterval> | undefined;
let titleWatchEpoch = 0;
const pollInFlight = new Set<string>();
const lastHistoryMetricAt = new Map<string, number>();
const lastHistoryRssMb = new Map<string, number>();
const emptyAskStreak = new Map<string, number>();
const lastPermissionCount = new Map<string, number>();
const lastTitles = new Map<string, string>();
const userPinnedTitles = new Set<string>();
const lastRevertCursors = new Map<string, string | null>();
const lastTodos = new Map<string, string>();
const compactIssued = new Set<string>();
const compactInFlight = new Set<string>();
const modelContextWindows = new Map<string, number>();
const lastPromptedModels = new Map<string, string>();
let lastPromptedModel: string | undefined;
let reconnecting = false;
let subscriptionGeneration = 0;
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
  dropSubscriptions();
  sessions.clear();
  sessionToThread.clear();
  liveTurns.clear();
  openingTurns.clear();
  parkedSteers.clear();
  pendingPermission.clear();
  pendingQuestion.clear();
  configuredSkillRoots = [];
  lastTitles.clear();
  userPinnedTitles.clear();
  titleWatchEpoch += 1;
  lastRevertCursors.clear();
  lastTodos.clear();
  compactIssued.clear();
  compactInFlight.clear();
  pollInFlight.clear();
  emptyAskStreak.clear();
  lastHistoryMetricAt.clear();
  lastHistoryRssMb.clear();

  lastPermissionCount.clear();
  resetDebugLogForTests();
  modelContextWindows.clear();
  lastPromptedModels.clear();
  lastPromptedModel = undefined;
  reconnecting = false;
  if (titleTimer) {
    clearInterval(titleTimer);
    titleTimer = undefined;
  }
  client = undefined;
  createCount = 0;
  unknownLogLines = [];
  dataDir = "/tmp/bb-oc-bridge-test";
  clearLivePermissionModes(dataDir);
  deps = {
    acquire: next?.acquire ?? createSdkClient,
    attach: next?.attach ?? (async (dir) => attachOrSpawn({ dataDir: dir })),
    write:
      next?.write ??
      ((message) => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      }),
    now: next?.now,
  };
}

export async function ingestOpenCodeEvent(event: {
  type: string;
  properties?: unknown;
}): Promise<void> {
  await onOpenCodeEvent(event);
}

export function recentUnknownLogLines(): string[] {
  return [...unknownLogLines, ...recentDebugLog()].slice(-80);
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

/**
 * BB only keeps the newest item's key resolvable, so a text bubble must be closed
 * before any other item opens. This is the one choke point every delta passes.
 */
function sealTextBeforeForeignItems(
  threadId: string,
  deltas: ThreadDelta[],
): ThreadDelta[] {
  const live = liveTurns.get(threadId);
  if (!live) return deltas;
  const sealed: ThreadDelta[] = [];
  for (const delta of deltas) {
    const open = live.mapState.openTextChannel;
    if (open) {
      const key = delta.key as { channel?: unknown; providerItemId?: unknown } | undefined;
      const itemId =
        typeof key?.providerItemId === "string"
          ? key.providerItemId
          : typeof key?.channel === "string"
            ? key.channel.replace(/^text:/, "")
            : undefined;
      const isAgentTextLifecycle =
        itemId?.startsWith("assistant:") &&
        (delta.kind === "item.textDelta" ||
          delta.kind === "item.textClose" ||
          delta.kind === "item.open" ||
          delta.kind === "item.close");
      if (!isAgentTextLifecycle) sealed.push(...sealOpenTextChannel(live.mapState));
    }
    sealed.push(delta);
  }
  return sealed;
}

function emitDeltas(threadId: string, input: ThreadDelta[]): void {
  const deltas = sealTextBeforeForeignItems(threadId, input);
  if (deltas.length === 0) return;
  for (const delta of deltas) {
    if (delta.kind !== "item.textDelta" && delta.kind !== "item.textClose") {
      continue;
    }
    debugLog(
      `emit ${delta.kind} key=${JSON.stringify(delta.key)} text=${JSON.stringify(
        String(delta.text ?? "").slice(0, 24),
      )}`,
    );
  }
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

function publicErrorMessage(error: unknown): string {
  if (isAbortTimeout(error)) {
    return "OpenCode serve did not answer in time";
  }
  return error instanceof Error ? error.message : String(error);
}

async function ensureClient(): Promise<OpenCodeClient> {
  if (client) {
    // Cheap liveness probe: the serve may have died and come back on a
    // different port (lock file updated); a cached client pointing at the
    // old URL never heals on its own. Drop it and re-attach from the lock.
    try {
      await client.health();
      return client;
    } catch {
      dropSubscriptions();
      client = undefined;
    }
  }
  if (!dataDir) throw new Error("bridge dataDir is not set");
  try {
    const attached = await deps.attach(dataDir);
    client = deps.acquire(attached.url);
    const health = await client.health();
    if (!isVersionInWindow(health.version)) {
      throw new Error(versionSkewMessage(health.version));
    }
  } catch (error) {
    client = undefined;
    throw new Error(publicErrorMessage(error));
  }
  void resubscribeBoundDirectories(client).catch((error) => {
    unknownLogLines.push(`subscribe-error ${String(error)}`);
    debugLog(`sse subscribe failed ${String(error)}`);
  });
  return client;
}

function boundDirectory(sessionId: string): string | undefined {
  const threadId = sessionToThread.get(sessionId);
  const cwd = threadId ? sessions.get(threadId)?.cwd : undefined;
  return cwd && cwd.length > 0 ? cwd : undefined;
}

const HISTORY_METRIC_INTERVAL_MS = 30_000;
const HISTORY_ESTIMATE_MAX_BYTES = 16 * 1024 * 1024;

function estimateHistoryBytes(messages: readonly HydrateMessage[]): number {
  let bytes = 0;
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): void => {
    if (bytes >= HISTORY_ESTIMATE_MAX_BYTES || value == null) return;
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      return;
    }
    if (depth > 6 || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      visit(item, depth + 1);
    }
  };
  visit(messages, 0);
  return Math.min(bytes, HISTORY_ESTIMATE_MAX_BYTES);
}

async function readSessionMessages(
  active: OpenCodeClient,
  sessionId: string,
  purpose: string,
  limit?: number,
): Promise<HydrateMessage[]> {
  const startedAt = deps.now?.() ?? Date.now();
  const messages = (await active.sessionMessages(sessionId, limit)) as HydrateMessage[];
  const finishedAt = deps.now?.() ?? Date.now();
  const durationMs = Math.max(0, finishedAt - startedAt);
  const metricKey = `${purpose}:${sessionId}`;
  const lastLoggedAt = lastHistoryMetricAt.get(metricKey) ?? 0;
  const shouldLog =
    limit === undefined || durationMs >= 250 || messages.length >= (limit ?? Infinity);
  if (shouldLog && finishedAt - lastLoggedAt >= HISTORY_METRIC_INTERVAL_MS) {
    lastHistoryMetricAt.set(metricKey, finishedAt);
    const bytes = estimateHistoryBytes(messages);
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const rssDeltaMb = rssMb - (lastHistoryRssMb.get(metricKey) ?? rssMb);
    lastHistoryRssMb.set(metricKey, rssMb);
    debugLog(
      `history purpose=${purpose} ses=${sessionId} count=${messages.length} limit=${limit ?? "all"} bytes~=${bytes} ms=${durationMs} rssMb=${rssMb} rssDeltaMb=${rssDeltaMb}`,
    );
  }
  return messages;
}

function dropSubscriptions(): void {
  subscriptionGeneration += 1;
  for (const sub of subscriptions.values()) {
    try {
      sub.unsubscribe();
    } catch {
      /* already closed */
    }
  }
  subscriptions.clear();
}

function failIssuedTurn(threadId: string, message: string): void {
  const live = liveTurns.get(threadId);
  if (live) {
    emptyAskStreak.delete(live.sessionId);
    lastPermissionCount.delete(live.sessionId);
  }
  if (live?.parentBoundaryEmitted) {
    liveTurns.delete(threadId);
    return;
  }
  if (live) {
    live.parentBoundaryEmitted = true;
    liveTurns.delete(threadId);
  }
  emitDeltas(threadId, [
    {
      kind: "turn.boundary",
      status: "failed",
      error: { message },
    },
  ]);
}

function failLiveTurns(message: string): void {
  const ids = [...liveTurns.keys()];
  for (const threadId of ids) failIssuedTurn(threadId, message);
}

function emitRetryWarning(args: {
  threadId: string;
  sessionId: string;
  messageId?: string;
  attempt?: number;
  message: string;
}): void {
  const live = liveTurns.get(args.threadId);
  if (!live || live.parentBoundaryEmitted) return;
  const key = retryKey({
    sessionId: args.sessionId,
    messageId: args.messageId,
    attempt: args.attempt,
  });
  if (live.retryWarned.has(key)) return;
  live.retryWarned.add(key);
  const attempt =
    typeof args.attempt === "number" ? `attempt ${args.attempt}` : "retry";
  debugLog(`retry ses=${args.sessionId} ${attempt}`);
  emitDeltas(args.threadId, [
    {
      kind: "provider.warning",
      category: "general",
      summary: `OpenCode ${attempt}`,
      details: args.message,
      vouchedTurn: true,
    },
  ]);
}

function isUserMessageText(
  live: LiveTurn,
  part: Record<string, unknown>,
): boolean {
  if (part.type !== "text" && part.type !== "text-delta") return false;
  const messageID =
    typeof part.messageID === "string" ? part.messageID : undefined;
  return Boolean(messageID && live.userMessageIds.has(messageID));
}

function isChildProseType(type: unknown): boolean {
  if (typeof type !== "string") return false;
  return (
    type === "text" ||
    type === "text-delta" ||
    type === "reasoning" ||
    type === "reasoning-delta" ||
    type.startsWith("session.next.text.") ||
    type.startsWith("session.next.reasoning.")
  );
}

function toolPartFromEvent(
  record: { part?: Record<string, unknown>; callID?: unknown } | undefined,
): Record<string, unknown> | undefined {
  const part = record?.part ?? record;
  if (!part || typeof part !== "object" || !("type" in part)) return undefined;
  const callID =
    typeof part.callID === "string"
      ? part.callID
      : typeof record?.callID === "string"
        ? record.callID
        : undefined;
  return callID && part.callID !== callID ? { ...part, callID } : part;
}

function closeLiveTurn(
  threadId: string,
  status: "failed" | "interrupted",
  message?: string,
): void {
  const live = liveTurns.get(threadId);
  if (!live || live.parentBoundaryEmitted) {
    liveTurns.delete(threadId);
    return;
  }
  live.parentBoundaryEmitted = true;
  const flushed = closePendingAgentText(live);
  liveTurns.delete(threadId);
  emitDeltas(threadId, [
    ...flushed,
    {
      kind: "turn.boundary",
      status,
      ...(status === "failed" && message ? { error: { message } } : {}),
    },
  ]);
}

function clearCompletedSteerRestart(live: LiveTurn): void {
  const restart = live.steerRestart;
  if (
    restart?.promptStarted &&
    !restart.expectAbortError &&
    !restart.expectAbortIdle
  ) {
    live.steerRestart = undefined;
  }
}

function serveLost(message: string): void {
  const had = Boolean(client || subscriptions.size > 0);
  dropSubscriptions();
  client = undefined;
  failLiveTurns(message);
  if (!had) return;
  notify(BRIDGE_NOTIFICATION_METHODS.providerRecovery, {
    kind: "restartRecommended",
    message,
    retryable: true,
  });
}

async function onStreamClosed(
  message: string,
  directory?: string,
): Promise<void> {
  const key = directory?.trim() ?? "";
  subscriptions.delete(key);
  debugLog(`sse off dir=${key || "-"}`);
  if (reconnecting) return;
  reconnecting = true;
  try {
    const active = client;
    if (active) {
      try {
        const health = await active.health();
        if (health.healthy && key) {
          await ensureSubscribed(active, key);
          return;
        }
        if (health.healthy) return;
      } catch {
        /* serve is gone */
      }
    }
    serveLost(message);
  } finally {
    reconnecting = false;
  }
}

async function ensureSubscribed(
  active: OpenCodeClient,
  directory?: string,
): Promise<void> {
  const key = directory?.trim() ?? "";
  if (!key || subscriptions.has(key)) return;
  const generation = subscriptionGeneration;
  const pending = {
    unsubscribe() {
      /* pending */
    },
  };
  subscriptions.set(key, pending);
  try {
    let overloaded = false;
    let lastMetricAt = 0;
    const pump = new OrderedEventPump(
      async (event) => {
        if (event.type === "server.disconnected") {
          await onStreamClosed("OpenCode event stream closed", key);
          return;
        }
        await onOpenCodeEvent(event);
      },
      {
        onError(error) {
          unknownLogLines.push(`event-handler-error ${String(error)}`);
        },
        onOverload(stats) {
          overloaded = true;
          debugLog(
            `event backlog dir=${key} depth=${stats.peakDepth} handled=${stats.handled} coalesced=${stats.coalesced} dropped=${stats.dropped} maxAgeMs=${stats.maxQueueAgeMs}`,
          );
        },
        async onIdle(stats) {
          const now = deps.now?.() ?? Date.now();
          if (now - lastMetricAt >= HISTORY_METRIC_INTERVAL_MS) {
            lastMetricAt = now;
            debugLog(
              `event metrics dir=${key} enqueued=${stats.enqueued} handled=${stats.handled} peakDepth=${stats.peakDepth} maxAgeMs=${stats.maxQueueAgeMs} maxHandlerMs=${stats.maxHandlerMs} coalesced=${stats.coalesced} dropped=${stats.dropped}`,
            );
          }
          if (!overloaded) return;
          overloaded = false;
          const sessionIds = [...liveTurns.values()]
            .filter(
              (live) =>
                !live.parentBoundaryEmitted && boundDirectory(live.sessionId) === key,
            )
            .map((live) => live.sessionId);
          debugLog(
            `event reconcile dir=${key} sessions=${sessionIds.length}`,
          );
          await Promise.all(sessionIds.map(reconcileActiveSession));
        },
      },
    );
    const sub = await active.subscribe((event) => pump.enqueue(event), key);
    if (generation !== subscriptionGeneration) {
      pump.close();
      sub.unsubscribe();
      return;
    }
    subscriptions.set(key, {
      unsubscribe() {
        pump.close();
        sub.unsubscribe();
      },
    });
    debugLog(`sse on dir=${key}`);
  } catch (error) {
    if (subscriptions.get(key) === pending) subscriptions.delete(key);
    throw error;
  }
}

async function resubscribeBoundDirectories(
  active: OpenCodeClient,
): Promise<void> {
  const dirs = new Set(
    [...sessions.values()]
      .map((session) => session.cwd.trim())
      .filter(Boolean),
  );
  for (const directory of dirs) {
    await ensureSubscribed(active, directory);
  }
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
  watchEnsureTitle(session.sessionId);
  if (client && session.cwd) {
    void ensureSubscribed(client, session.cwd).catch((error) => {
      unknownLogLines.push(`subscribe-error ${String(error)}`);
      debugLog(`sse subscribe failed ${String(error)}`);
    });
  }
}

async function reconcileActiveSession(sessionId: string): Promise<void> {
  if (pollInFlight.has(sessionId)) return;
  pollInFlight.add(sessionId);
  try {
    await syncSessionTitle(sessionId);
    await syncPendingPermissions(sessionId);
    await syncLiveTurnParts(sessionId);
    await syncSessionRevert(sessionId);
    await syncSessionTodos(sessionId);
  } finally {
    pollInFlight.delete(sessionId);
  }
}

function startTitlePoller(): void {
  if (titleTimer) return;
  titleTimer = setInterval(() => {
    // SSE drives idle sessions. Poll only active/recovering turns as a bounded
    // watchdog for missed provider events.
    const activeSessionIds = new Set(
      [...liveTurns.values()]
        .filter((live) => !live.parentBoundaryEmitted)
        .map((live) => live.sessionId),
    );
    for (const pending of pendingPermission.values()) {
      activeSessionIds.add(pending.sessionId);
    }
    for (const pending of pendingQuestion.values()) {
      activeSessionIds.add(pending.sessionId);
    }
    void Promise.all([...activeSessionIds].map(reconcileActiveSession));
  }, 800);
  titleTimer.unref?.();
}

function hasStreamedAgentText(live: LiveTurn): boolean {
  return [...live.mapState.emittedText.keys()].some(
    (key) => !key.startsWith("reasoning:"),
  );
}

function currentAssistantMessages(
  live: LiveTurn,
  messages: readonly HydrateMessage[],
): HydrateMessage[] {
  if (live.bindOnly) {
    return messages.filter((message) => message.info.role === "assistant");
  }
  const userMessageId = live.pollUserMessageId;
  if (!userMessageId) return assistantsAfterLastUser(messages);
  const boundary = messages.findIndex(
    (message) =>
      message.info.role === "user" && message.info.id === userMessageId,
  );
  if (boundary < 0) return [];
  if (
    messages
      .slice(boundary + 1)
      .some((message) => message.info.role === "user")
  ) {
    return [];
  }
  return messages
    .slice(boundary + 1)
    .filter((message) => message.info.role === "assistant");
}

function closePendingAgentText(live: LiveTurn): ThreadDelta[] {
  const deltas: ThreadDelta[] = [];
  for (const [id, text] of live.textBuffers) {
    if (live.mapState.closedTextChannels.has(id)) continue;
    deltas.push(...closeText(id, text));
    live.mapState.closedTextChannels.add(id);
  }
  live.textBuffers.clear();
  for (const [id, text] of live.mapState.emittedText) {
    if (id.startsWith("reasoning:") || live.mapState.closedTextChannels.has(id)) continue;
    deltas.push(...closeText(id, text));
    live.mapState.closedTextChannels.add(id);
  }
  return deltas;
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
    const messages = await readSessionMessages(
      client,
      sessionId,
      "live",
      RECONCILE_HISTORY_LIMIT,
    );
    const leftovers: ThreadDelta[] = [];
    for (const message of messages) {
      if (message.info.role === "user" && typeof message.info.id === "string") {
        live.userMessageIds.add(message.info.id);
      }
    }
    // Poll only after OpenCode has persisted the exact user message dispatched
    // for this BB turn. A bounded tail may contain only assistant step messages,
    // so inferring this boundary from prior history can remint an older turn.
    if (
      live.promptIssued &&
      !live.bindOnly &&
      (!live.pollUserMessageId ||
        lastUserMessageId(messages) !== live.pollUserMessageId)
    ) {
      return false;
    }
    const assistantMessages = currentAssistantMessages(live, messages);
    // ponytail: SSE already painted this turn; persist part ids differ and remint new BB items
    const streamedText = hasStreamedAgentText(live);
    for (const message of assistantMessages) {
      for (const part of message.parts) {
        rememberTaskChild(live, part);
        if (
          streamedText &&
          (part.type === "text" || part.type === "text-delta")
        ) {
          continue;
        }
        leftovers.push(
          ...mapPartDelta({
            state: live.mapState,
            part,
            sessionId,
          }),
        );
        void maybeCardQuestionFromPart(
          sessionId,
          part as Record<string, unknown>,
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
        const childMessages = await readSessionMessages(
          client,
          child.id,
          "child-live",
          RECONCILE_HISTORY_LIMIT,
        );
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
    await maybeFailUncardedWrite(sessionId, messages);
    if (leftovers.length > 0) emitDeltas(threadId, leftovers);
    await completeBindOnlyIfIdle(threadId, sessionId, messages);
    return leftovers.length > 0;
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
    // The BB event log is append-only: replaying retained provider messages
    // here duplicates the visible prefix instead of replacing the old suffix.
    // The app projects the reversible suffix from the authoritative cursor;
    // normal resume hydration remains responsible for a newly bound session.
    return true;
  } catch {
    return false;
  }
}

export async function syncSessionTitle(sessionId: string): Promise<boolean> {
  if (!client) return false;
  if (userPinnedTitles.has(sessionId)) return false;
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
    const pending = await client.listPendingPermissions(
      sessionId,
      boundDirectory(sessionId),
    );
    lastPermissionCount.set(sessionId, pending.length);
    for (const ask of pending) {
      await handlePermissionAsked(ask, sessionId);
    }
  } catch {
    /* list is best-effort; SSE remains the primary path */
  }
}

async function maybeFailUncardedWrite(
  sessionId: string,
  messages: Array<{ parts?: Array<Record<string, unknown>> }>,
): Promise<void> {
  if (!client) return;
  const threadId = sessionToThread.get(sessionId);
  if (!threadId) return;
  const live = liveTurns.get(threadId);
  if (!live || live.parentBoundaryEmitted) return;
  const runningTool = runningFileToolName(messages);
  const hasCard = [...pendingPermission.values()].some(
    (pending) => pending.sessionId === sessionId,
  );
  const next = nextUncardedWriteStreak({
    runningTool,
    pendingAskCount: lastPermissionCount.get(sessionId) ?? 0,
    hasCard,
    streak: emptyAskStreak.get(sessionId) ?? 0,
  });
  if (next.streak === 0) emptyAskStreak.delete(sessionId);
  else emptyAskStreak.set(sessionId, next.streak);
  if (!next.giveUp || !runningTool) return;
  debugLog(`ask timeout ses=${sessionId} tool=${runningTool} abort`);
  try {
    await client.abort(sessionId);
  } catch {
    /* still fail the BB turn */
  }
  failIssuedTurn(
    threadId,
    "OpenCode write is waiting without a permission card",
  );
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
  options?: { skipUserInput?: boolean },
): Promise<void> {
  const session = await active.getSession(sessionId);
  const cursor = revertMessageIdOf(session) ?? null;
  lastRevertCursors.set(sessionId, cursor);
  const startedAt = deps.now?.() ?? Date.now();
  const complete = await readCompleteHistory(active, sessionId);
  const messages = filterMessagesByRevertPoint(
    complete.messages,
    cursor ?? undefined,
  );
  debugLog(
    `history hydrate-complete ses=${sessionId} count=${messages.length} pages=${complete.pages} paginated=${complete.paginated} durationMs=${Math.max(0, (deps.now?.() ?? Date.now()) - startedAt)} bytes~=${estimateHistoryBytes(messages)} rssMb=${Math.round(process.memoryUsage().rss / 1024 / 1024)}`,
  );
  await rememberCatalogWindows(active);
  emitDeltas(threadId, [
    ...hydrateDeltas({
      sessionId,
      messages,
      skipUserInput: options?.skipUserInput,
    }),
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
    retryWarned: new Set(),
    userMessageIds: new Set(),
  });
  emitDeltas(threadId, [{ kind: "turn.open" }]);
}

async function joinRunningSession(
  threadId: string,
  sessionId: string,
): Promise<void> {
  attachObservedTurn(threadId, sessionId);
  await syncLiveTurnParts(sessionId);
}

function completeBindOnlyTurn(
  threadId: string,
  messages?: readonly HydrateMessage[],
): boolean {
  const live = liveTurns.get(threadId);
  if (!live || live.parentBoundaryEmitted || live.promptIssued || !live.bindOnly) {
    return false;
  }
  live.parentBoundaryEmitted = true;
  liveTurns.delete(threadId);
  emitDeltas(threadId, [completedTurnBoundary(messages)]);
  return true;
}

/** First completed assistant step is not idle. Close only when OpenCode is idle. */
async function completeBindOnlyIfIdle(
  threadId: string,
  sessionId: string,
  messages: readonly HydrateMessage[],
): Promise<boolean> {
  const live = liveTurns.get(threadId);
  if (!live || live.parentBoundaryEmitted || live.promptIssued || !live.bindOnly) {
    return false;
  }
  if (!lastAssistantSettled(messages) || !client) return false;
  try {
    if (await client.sessionIsRunning(sessionId, boundDirectory(sessionId))) {
      return false;
    }
  } catch {
    return false;
  }
  return completeBindOnlyTurn(threadId, messages);
}

async function finishBindOnlyStart(args: {
  threadId: string;
  sessionId: string;
  active: OpenCodeClient;
}): Promise<void> {
  if (!liveTurns.has(args.threadId)) {
    liveTurns.set(args.threadId, {
      threadId: args.threadId,
      sessionId: args.sessionId,
      promptIssued: false,
      mapState: createMapDeltaState(),
      textBuffers: new Map(),
      parentBoundaryEmitted: false,
      liveChildIds: new Set(),
      childWork: new Map(),
      pendingPrompts: [],
      retryWarned: new Set(),
      userMessageIds: new Set(),
      bindOnly: true,
    });
    emitDeltas(args.threadId, [{ kind: "turn.open" }]);
  } else {
    const live = liveTurns.get(args.threadId);
    if (live) live.bindOnly = true;
  }
  await syncLiveTurnParts(args.sessionId);
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

function questionPartFromEvent(event: {
  type: string;
  properties?: unknown;
}): Record<string, unknown> | undefined {
  const properties =
    event.properties && typeof event.properties === "object"
      ? (event.properties as Record<string, unknown>)
      : undefined;
  if (!properties) return undefined;
  if (event.type === "session.next.tool.called") {
    const tool = typeof properties.tool === "string" ? properties.tool : undefined;
    if (!isQuestionToolName(tool)) return undefined;
    return {
      id: properties.callID,
      callID: properties.callID,
      tool,
      state: { status: "running", input: properties.input },
    };
  }
  if (
    event.type === "message.part.updated" ||
    event.type === "message.part.delta"
  ) {
    const part =
      properties.part && typeof properties.part === "object"
        ? (properties.part as Record<string, unknown>)
        : properties;
    if (!part || typeof part.tool !== "string") return undefined;
    if (!isQuestionToolName(part.tool)) return undefined;
    return part;
  }
  return undefined;
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
  if (info && typeof info === "object") {
    const rec = info as { sessionID?: unknown; id?: unknown };
    if (typeof rec.sessionID === "string") return rec.sessionID;
    if (typeof rec.id === "string") return rec.id;
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
    await onStreamClosed("OpenCode event stream closed");
    return;
  }
  const sessionId = eventSessionId(event);
  if (!sessionId) {
    if (event.type === "session.error") {
      const error =
        event.properties && typeof event.properties === "object"
          ? (event.properties as { error?: unknown }).error
          : undefined;
      const described = describeSessionError(error);
      for (const threadId of [...liveTurns.keys()]) {
        closeLiveTurn(threadId, described.status, described.message);
      }
      return;
    }
    if (isQuestionAskEvent(event.type)) {
      const ask = unwrapQuestionAsk(event.properties);
      if (ask) await handleQuestionAsked(event.properties, ask.sessionID);
    }
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
  const questionPart = questionPartFromEvent(event);
  if (questionPart) {
    await maybeCardQuestionFromPart(sessionId, questionPart);
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

  if (event.type === "session.created") {
    const parentId = eventParentId(event.properties);
    const parentThreadId = parentId ? sessionToThread.get(parentId) : undefined;
    const parentLive = parentThreadId ? liveTurns.get(parentThreadId) : undefined;
    if (parentLive) {
      parentLive.liveChildIds.add(sessionId);
      noteLiveTaskChild({
        parentThreadId: parentLive.threadId,
        parentSessionId: parentLive.sessionId,
        childSessionId: sessionId,
        title: sessionTitle(event.properties),
        running: true,
      });
    }
    return;
  }

  if (event.type === "session.updated" || event.type === "session.diff") {
    if (childId) return;
    if (userPinnedTitles.has(sessionId)) {
      void syncSessionRevert(sessionId);
      return;
    }
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
    const childPrompt = userPromptFromEvent(event);
    if (childPrompt) {
      noteLiveTaskChild({
        parentThreadId: live.threadId,
        parentSessionId: live.sessionId,
        childSessionId: id,
        prompt: childPrompt,
        running: true,
      });
    }
    if (event.type === "session.idle" || event.type === "session.status") {
      const childStatus =
        event.type === "session.idle"
          ? { kind: "idle" as const }
          : readSessionStatus(event.properties);
      if (childStatus.kind === "retry") {
        emitRetryWarning({
          threadId,
          sessionId: id,
          attempt: childStatus.attempt,
          message: childStatus.message || "Retrying",
        });
        return;
      }
      if (childStatus.kind === "busy") {
        debugLog(`status busy ses=${id}`);
        return;
      }
      if (childStatus.kind === "idle" || event.type === "session.idle") {
        live.liveChildIds.delete(id);
        noteLiveTaskChild({
          parentThreadId: live.threadId,
          parentSessionId: live.sessionId,
          childSessionId: id,
          running: false,
        });
      }
      return;
    }
    if (event.type.startsWith("session.next.")) {
      // BB renders final child prose from the delegation summary; nesting it duplicates Output.
      if (isChildProseType(event.type)) return;
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
          ? (event.properties as { part?: Record<string, unknown>; callID?: unknown })
          : undefined;
      const part = toolPartFromEvent(record);
      if (part) {
        const retry = retryFromPart(part);
        if (retry) {
          emitRetryWarning({
            threadId,
            sessionId: id,
            messageId: retry.messageId,
            attempt: retry.attempt,
            message: retry.message,
          });
        }
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
    const record =
      info && typeof info === "object" ? (info as { id?: unknown; role?: unknown }) : undefined;
    if (record?.role === "user" && typeof record.id === "string") {
      live.userMessageIds.add(record.id);
    }
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
    const properties =
      event.properties && typeof event.properties === "object"
        ? (event.properties as { textID?: unknown })
        : undefined;
    const textId =
      typeof properties?.textID === "string" ? properties.textID : undefined;
    if (textId) {
      debugLog(
        `sse ${event.type} textID=${textId} text=${JSON.stringify(
          String((properties as { text?: unknown }).text ?? "").slice(0, 24),
        )}`,
      );
    }
    if (textId && event.type === "session.next.text.delta") {
      const channel = resolveAgentTextChannel(live.mapState, textId);
      const text = live.mapState.emittedText.get(channel);
      if (text && !live.mapState.closedTextChannels.has(channel)) live.textBuffers.set(channel, text);
    } else if (textId && event.type === "session.next.text.ended") {
      const endedText =
        typeof (properties as { text?: unknown }).text === "string"
          ? (properties as { text: string }).text
          : undefined;
      const channel = resolveAgentTextChannel(live.mapState, textId, endedText);
      const final =
        endedText?.trim() ? endedText : (live.mapState.emittedText.get(channel) ?? "");
      if (final.trim()) {
        live.textBuffers.delete(channel);
        live.mapState.closedTextChannels.add(channel);
      }
    }
    if (nextDeltas.length > 0) emitDeltas(threadId, nextDeltas);
    return;
  }

  if (event.type === "message.part.delta" || event.type === "message.part.updated") {
    const record =
      event.properties && typeof event.properties === "object"
        ? (event.properties as {
            part?: Record<string, unknown>;
            delta?: unknown;
            callID?: unknown;
          })
        : undefined;
    const part = toolPartFromEvent(record);
    const delta = typeof record?.delta === "string" ? record.delta : undefined;
    if (part) {
      const retry = retryFromPart(part);
      if (retry) {
        emitRetryWarning({
          threadId,
          sessionId,
          messageId: retry.messageId,
          attempt: retry.attempt,
          message: retry.message,
        });
      }
      if (isUserMessageText(live, part)) return;
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
      if (toolPartWasRejected(part)) {
        forgetPendingPermissions(threadId);
      }
      const typed = part as { id?: string; type?: string; text?: string };
      if ((typed.type === "text" || typed.type === "text-delta") && typed.id) {
        debugLog(
          `part ${event.type} id=${typed.id} text=${JSON.stringify(
            String(typed.text ?? "").slice(0, 24),
          )}`,
        );
        const channel = resolveAgentTextChannel(
          live.mapState,
          typed.id,
          typed.text,
        );
        const latest = live.mapState.emittedText.get(channel);
        if (latest && !live.mapState.closedTextChannels.has(channel)) {
          live.textBuffers.set(channel, latest);
        }
      }
    }
    return;
  }

  if (event.type === "session.idle" || event.type === "session.status") {
    const status =
      event.type === "session.idle"
        ? { kind: "idle" as const }
        : readSessionStatus(event.properties);
    if (status.kind === "retry") {
      emitRetryWarning({
        threadId,
        sessionId,
        attempt: status.attempt,
        message: status.message || "Retrying",
      });
      return;
    }
    if (status.kind === "busy") {
      debugLog(`status busy ses=${sessionId}`);
      return;
    }
    const idle = event.type === "session.idle" || status.kind === "idle";
    if (!idle) return;
    if (
      sessionId === live.sessionId &&
      live.steerRestart?.expectAbortIdle
    ) {
      live.steerRestart.expectAbortIdle = false;
      clearCompletedSteerRestart(live);
      debugLog(`abort idle ignored for steer restart ses=${sessionId}`);
      return;
    }
    if (sessionId !== live.sessionId) {
      live.liveChildIds.delete(sessionId);
      return;
    }
    if (
      [...pendingQuestion.values()].some(
        (pending) =>
          pending.threadId === threadId && pending.status !== "settled",
      )
    ) {
      debugLog(`idle wait question ses=${sessionId}`);
      return;
    }
    if (
      [...pendingPermission.values()].some(
        (pending) => pending.threadId === threadId,
      )
    ) {
      if (client) {
        let stillWaiting = false;
        try {
          const asks = await client.listPendingPermissions(
            sessionId,
            boundDirectory(sessionId),
          );
          stillWaiting = asks.length > 0;
        } catch {
          stillWaiting = true;
        }
        if (stillWaiting) {
          debugLog(`idle wait card ses=${sessionId}`);
          return;
        }
        forgetPendingPermissions(threadId);
        await settleIssuedTurn(threadId, sessionId, client);
        return;
      }
      debugLog(`idle wait card ses=${sessionId}`);
      return;
    }
    if (client) {
      await settleIssuedTurn(threadId, sessionId, client);
      return;
    }
    if (!live.parentBoundaryEmitted) {
      live.parentBoundaryEmitted = true;
      emitDeltas(threadId, closePendingAgentText(live));
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
    const error =
      event.properties && typeof event.properties === "object"
        ? (event.properties as { error?: unknown }).error
        : undefined;
    const described = describeSessionError(error);
    debugLog(`session error ses=${sessionId} ${described.status}`);
    if (sessionId === live.sessionId) {
      const name =
        error && typeof error === "object"
          ? (error as { name?: unknown }).name
          : undefined;
      if (
        name === "MessageAbortedError" &&
        live.steerRestart?.expectAbortError
      ) {
        live.steerRestart.expectAbortError = false;
        clearCompletedSteerRestart(live);
        debugLog(`abort error ignored for steer restart ses=${sessionId}`);
        return;
      }
      closeLiveTurn(threadId, described.status, described.message);
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

function userPromptFromEvent(event: {
  type: string;
  properties?: unknown;
}): string | undefined {
  if (!event.properties || typeof event.properties !== "object") return undefined;
  const record = event.properties as Record<string, unknown>;
  const info =
    record.info && typeof record.info === "object"
      ? (record.info as { role?: unknown; parts?: unknown })
      : undefined;
  if (info?.role && info.role !== "user") return undefined;
  const blobs: unknown[] = [];
  if (Array.isArray(record.parts)) blobs.push(...record.parts);
  if (Array.isArray(info?.parts)) blobs.push(...info.parts);
  if (record.part) blobs.push(record.part);
  const texts: string[] = [];
  for (const blob of blobs) {
    if (!blob || typeof blob !== "object") continue;
    const part = blob as { type?: unknown; text?: unknown };
    if (part.type && part.type !== "text") continue;
    if (typeof part.text === "string" && part.text.trim()) texts.push(part.text.trim());
  }
  if (typeof record.text === "string" && record.text.trim()) texts.push(record.text.trim());
  return texts.length > 0 ? texts.join("\n") : undefined;
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
  const parentItemId = part.callID ?? part.id;
  if (!childId || !parentItemId) return undefined;
  live.liveChildIds.add(childId);
  noteLiveTaskChild({
    parentThreadId: live.threadId,
    parentSessionId: live.sessionId,
    childSessionId: childId,
    prompt: taskChildPrompt(part),
    running: true,
  });
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
  const activityParts = parts.filter((part) => !isChildProseType(part.type));
  if (activityParts.length === 0) return [];
  const deltas: ThreadDelta[] = [];
  if (!work.turnOpened) {
    work.turnOpened = true;
    deltas.push({
      kind: "turn.open",
      providerTurnId: childId,
      parentRef: work.parentItemId,
    });
  }
  for (const part of activityParts) {
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

function forgetPendingPermissions(threadId: string): void {
  for (const [key, pending] of pendingPermission) {
    if (pending.threadId === threadId) pendingPermission.delete(key);
  }
}

function toolPartWasRejected(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const state = (part as { state?: { status?: unknown; error?: unknown } })
    .state;
  if (!state || state.status !== "error") return false;
  return String(state.error ?? "").includes("rejected permission");
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
        directory: boundDirectory(args.sessionId),
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
      await client
        .rejectQuestion({
          requestID: requestId,
          sessionID: sessionId,
          directory: boundDirectory(sessionId),
        })
        .catch(() => undefined);
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
    status: "pending",
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

async function maybeCardQuestionFromPart(
  sessionId: string,
  part: Record<string, unknown>,
): Promise<void> {
  if (!isQuestionToolName(
    typeof part.tool === "string" ? part.tool : undefined,
  )) {
    return;
  }
  const state =
    part.state && typeof part.state === "object"
      ? (part.state as { status?: unknown })
      : undefined;
  if (state?.status !== "running") return;
  if (!client) return;
  try {
    const pending = await client.listPendingQuestions(
      sessionId,
      boundDirectory(sessionId),
    );
    const asks = pending.flatMap((raw) => {
      const ask = unwrapQuestionAsk(raw);
      return ask ? [ask] : [];
    });
    const callID = typeof part.callID === "string" ? part.callID : undefined;
    const messageID =
      typeof part.messageID === "string" ? part.messageID : undefined;
    const matched = asks.filter(
      (ask) =>
        (callID && ask.tool?.callID === callID) ||
        (messageID && ask.tool?.messageID === messageID),
    );
    const candidates = matched.length > 0 ? matched : asks.length === 1 ? asks : [];
    for (const ask of candidates) {
      await handleQuestionAsked(ask, sessionId);
    }
  } catch {
    /* polling retries; tool-part IDs are not provider question IDs */
  }
}

function forgetQuestions(threadId: string): void {
  for (const [key, pending] of pendingQuestion) {
    if (pending.threadId === threadId) pendingQuestion.delete(key);
  }
}

async function rejectPendingQuestions(threadId: string): Promise<void> {
  const active = client;
  for (const [key, pending] of [...pendingQuestion]) {
    if (pending.threadId !== threadId) continue;
    pendingQuestion.delete(key);
    if (!active || pending.status === "settled") continue;
    try {
      await active.rejectQuestion({
        requestID: pending.requestId,
        sessionID: pending.sessionId,
        directory: boundDirectory(pending.sessionId),
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
        directory: boundDirectory(pending.sessionId),
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
    debugLog(`ask drop ses=${sessionId} ${attach.reason}`);
    return;
  }
  const targetThreadId = attach.threadId;
  if (parentLive && parentSessionId) {
    parentLive.liveChildIds.add(sessionId);
  }

  const live = liveTurns.get(targetThreadId);
  const permissionMode =
    readLivePermissionMode(dataDir, targetThreadId) ??
    sessions.get(targetThreadId)?.permissionMode;

  if (mapped.requestId) {
    const existing = `oc-perm-${mapped.requestId}`;
    if (pendingPermission.has(existing)) return;
  }
  if (mapped.tag === "deferred") {
    debugLog(`ask wait ses=${sessionId} bash command pending`);
    return;
  }
  if (mapped.tag === "unknown" || !mapped.requestId || !mapped.subject) {
    debugLog(
      `ask ignore ses=${sessionId} ${mapped.reason ?? "unmappable permission ask"}`,
    );
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
      directory: boundDirectory(sessionId),
    });
    return;
  }
  if (!shouldShowCard({ tag: mapped.tag, permissionMode }) || !live) {
    debugLog(
      `ask ignore ses=${sessionId} ${
        !live ? "no live turn" : "permission ask not shown"
      }`,
    );
    return;
  }

  const requestId = `oc-perm-${mapped.requestId}`;
  debugLog(`ask card ses=${sessionId} id=${mapped.requestId}`);
  if (mapped.subject.kind === "command") {
    emitDeltas(
      targetThreadId,
      openCommandItem(live.mapState, {
        itemId: mapped.subject.itemId,
        command: mapped.subject.command,
        cwd: mapped.subject.cwd,
      }),
    );
  }
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
}): Promise<
  | { ok: true; agent: string; inheritSession: boolean }
  | { ok: false; reason: string }
> {
  const agents = (await args.active.agents()) as OpenCodeAgent[];
  const messages = await readSessionMessages(
    args.active,
    args.sessionId,
    "agent",
    PROMPT_HISTORY_LIMIT,
  );
  return resolveContinueAgent({
    requested: args.requested,
    lastUserAgent: lastUserAgent(messages),
    agents,
  });
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
        threadRename: true,
        fork: "checkpoint",
        approvalEnforcedBy: "provider",
        steerMode: "queue",
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: (id) => {
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

  [BRIDGE_REQUEST_METHODS.providerUsage]: (id) => {
    respondResult(id, {
      supported: true,
      usage: {
        status: "error",
        message:
          "OpenCode does not expose account quota. Use the thread context meter.",
        accountEmail: null,
        planLabel: "OpenCode",
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
        rememberModelWindows(modelContextWindows, catalog.providers ?? []);
        const models = listPickerModels(catalog.providers ?? []).map((row) => {
          const supportedReasoningEfforts = supportedReasoningEffortsForModel(
            row.raw,
          );
          return {
            id: row.id,
            model: row.model,
            displayName: row.displayName,
            description: row.description,
            routeProviderId: row.routeProviderId,
            supportedReasoningEfforts,
            defaultReasoningEffort: defaultReasoningEffortFor(
              supportedReasoningEfforts,
            ),
            isDefault: false,
          };
        });
        let configured: string | undefined;
        try {
          configured = configDefaultModelId(await active.getConfig());
        } catch {
          configured = undefined;
        }
        const preferred =
          models.find((model) => model.id === lastPromptedModel) ??
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
      let answered = false;
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
          bindOnly: options.bindOnly === true,
          permissionMode: permissionModeOf(parsed.data.options),
          ...sessionPolicy(parsed.data),
        };
        bindSession(parsed.data.threadId, bound);
        emitDeltas(parsed.data.threadId, [{ kind: "session.reset" }]);
        respondResult(id, { providerThreadId: sessionId });
        answered = true;
        if (adoptId) {
          await replayHydrate(parsed.data.threadId, sessionId, active, {
            skipUserInput: options.bindOnly === true,
          });
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
          openingTurns.add(parsed.data.threadId);
          try {
            await runPrompt({
              threadId: parsed.data.threadId,
              sessionId,
              input,
              options: parsed.data.options,
              clientRequestId: undefined,
            });
          } finally {
            closeOpeningTurn(parsed.data.threadId);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!answered) {
          respondError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, message);
          return;
        }
        failIssuedTurn(parsed.data.threadId, message);
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
        if (await active.sessionIsRunning(parsed.data.providerThreadId)) {
          await joinRunningSession(
            parsed.data.threadId,
            parsed.data.providerThreadId,
          );
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
        const forkedId = requireSessionId(forked.id, "session.fork");
        bindSession(parsed.data.threadId, {
          threadId: parsed.data.threadId,
          sessionId: forkedId,
          cwd: parsed.data.cwd,
          permissionMode: permissionModeOf(parsed.data.options),
          ...sessionPolicy(parsed.data),
        });
        respondResult(id, { providerThreadId: forkedId });
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
        openingTurns.add(parsed.data.threadId);
        try {
          // ponytail: agent-only bind seed must not become a second OpenCode prompt
          if (
            bound.bindOnly &&
            firstTextPart(parsed.data.input ?? []).trim() === TASK_CHILD_BIND_TEXT
          ) {
            bound.bindOnly = false;
            if (parsed.data.clientRequestId) {
              emitDeltas(parsed.data.threadId, [
                {
                  kind: "input.accepted",
                  clientRequestId: parsed.data.clientRequestId,
                },
              ]);
            }
            return;
          }
          await runPrompt({
            threadId: parsed.data.threadId,
            sessionId: bound.sessionId,
            input: parsed.data.input,
            options: parsed.data.options,
            clientRequestId: parsed.data.clientRequestId,
          });
        } finally {
          closeOpeningTurn(parsed.data.threadId);
        }
      } catch (error) {
        failIssuedTurn(
          parsed.data.threadId,
          error instanceof Error ? error.message : String(error),
        );
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
    }).catch((error) => {
      unknownLogLines.push(`steer-error ${String(error)}`);
      emitDeltas(parsed.data.threadId, [
        {
          kind: "provider.warning",
          category: "general",
          summary: "Could not deliver follow-up",
          details: error instanceof Error ? error.message : String(error),
          vouchedTurn: true,
        },
      ]);
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

  [BRIDGE_REQUEST_METHODS.threadNameSet]: (id, params) => {
    const parsed = threadNameSetParamsSchema.safeParse(params);
    if (!parsed.success) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "Invalid params for thread/name/set",
        parsed.error.issues,
      );
      return;
    }
    void (async () => {
      try {
        const sessionId = parsed.data.providerThreadId;
        const title = parsed.data.title.trim();
        if (!title) {
          respondError(
            id,
            BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
            "Thread title is empty",
          );
          return;
        }
        const active = await ensureClient();
        lastTitles.set(sessionId, title);
        userPinnedTitles.add(sessionId);
        await active.updateSession(sessionId, { title });
        debugLog(`title set ses=${sessionId} ${title}`);
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
    let stoppingLive =
      parsed.data.intent === "interrupt"
        ? liveTurns.get(parsed.data.threadId)
        : undefined;
    if (stoppingLive) stoppingLive.stopping = true;
    void (async () => {
      try {
        if (parsed.data.intent === "interrupt") {
          const active = await ensureClient();
          await rejectPendingPermissions(parsed.data.threadId);
          const live = stoppingLive ?? liveTurns.get(parsed.data.threadId);
          if (live) {
            live.stopping = true;
            stoppingLive = live;
          }
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
        if (
          stoppingLive &&
          liveTurns.get(parsed.data.threadId) === stoppingLive &&
          !stoppingLive.parentBoundaryEmitted
        ) {
          stoppingLive.stopping = false;
        }
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
  if (!liveAfter || liveAfter.parentBoundaryEmitted || liveAfter.settling) return;
  const queued = takeQueuedSteer(threadId, liveAfter);
  if (queued) {
    await flushSteerBody(threadId, sessionId, active, liveAfter, queued);
    return;
  }
  liveAfter.settling = true;
  let messages: HydrateMessage[];
  try {
    messages = await readSessionMessages(
      active,
      sessionId,
      "settle",
      RECONCILE_HISTORY_LIMIT,
    );
  } catch (error) {
    liveAfter.settling = false;
    failIssuedTurn(
      threadId,
      `Could not finalize OpenCode turn: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  const lateQueued = takeQueuedSteer(threadId, liveAfter);
  if (lateQueued) {
    liveAfter.settling = false;
    await flushSteerBody(threadId, sessionId, active, liveAfter, lateQueued);
    return;
  }
  const leftovers: ThreadDelta[] = [];
  const streamedText = hasStreamedAgentText(liveAfter);
  debugLog(
    `settle streamed=${streamedText} emitted=${JSON.stringify([...liveAfter.mapState.emittedText].map(([k, v]) => `${k}=${v.slice(0, 12)}`))} closed=${JSON.stringify([...liveAfter.mapState.closedTextChannels])} buffers=${JSON.stringify([...liveAfter.textBuffers.keys()])}`,
  );
  const assistantMessages = currentAssistantMessages(liveAfter, messages);
  if (
    liveAfter.pollUserMessageId &&
    assistantMessages.length === 0 &&
    !messages.some((message) => message.info.id === liveAfter.pollUserMessageId)
  ) {
    debugLog(
      `settle boundary outside bounded history ses=${sessionId} limit=${RECONCILE_HISTORY_LIMIT}`,
    );
  }
  for (const message of assistantMessages) {
    for (const part of message.parts) {
      if (part.type === "text" || part.type === "text-delta") {
        if (streamedText) {
          const body = part.text;
          if (typeof body === "string" && body.length > 0) {
            for (const [id, text] of liveAfter.mapState.emittedText) {
              if (id.startsWith("reasoning:") || liveAfter.mapState.closedTextChannels.has(id)) {
                continue;
              }
              if (text === body) {
                leftovers.push(...closeText(id, text));
                liveAfter.mapState.closedTextChannels.add(id);
                liveAfter.textBuffers.delete(id);
                break;
              }
            }
          }
          continue;
        }
        leftovers.push(
          ...mapPartDelta({
            state: liveAfter.mapState,
            part,
            sessionId,
          }),
        );
        if (part.text && part.id) {
          leftovers.push(
            ...closeText(
              resolveAgentTextChannel(liveAfter.mapState, part.id, part.text),
              part.text,
            ),
          );
        }
        continue;
      }
      leftovers.push(
        ...mapPartDelta({
          state: liveAfter.mapState,
          part,
          sessionId,
        }),
      );
    }
  }
  leftovers.push(...closePendingAgentText(liveAfter));
  if (leftovers.length > 0) emitDeltas(threadId, leftovers);
  liveAfter.parentBoundaryEmitted = true;
  forgetQuestions(threadId);
  liveTurns.delete(threadId);
  await rememberCatalogWindows(active);
  emitDeltas(threadId, [
    completedTurnBoundary(messages),
    ...usageDeltasFromMessages(messages, modelContextWindows),
  ]);
  // Native ensureTitle forks on the first prompt step and may finish after idle.
  await syncSessionTitle(sessionId);
  watchEnsureTitle(sessionId);
}

function publishedOpenCodeTitle(sessionId: string): boolean {
  const title = lastTitles.get(sessionId);
  return Boolean(title && shouldPublishOpenCodeTitle(title));
}

const TITLE_WATCH_MS = process.env.VITEST
  ? [1, 1, 1]
  : [800, 2000, 4000, 8000, 15000];

/** ensureTitle is `forkIn` and often dies when `small_model` 503s. */
function watchEnsureTitle(sessionId: string): void {
  if (publishedOpenCodeTitle(sessionId)) return;
  const epoch = titleWatchEpoch;
  void (async () => {
    for (const delay of TITLE_WATCH_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (epoch !== titleWatchEpoch) return;
      if (publishedOpenCodeTitle(sessionId)) return;
      if (await syncSessionTitle(sessionId)) return;
    }
    if (epoch !== titleWatchEpoch) return;
    await recoverEnsureTitle(sessionId);
  })();
}

async function recoverEnsureTitle(sessionId: string): Promise<boolean> {
  if (!client || publishedOpenCodeTitle(sessionId)) return false;
  if (userPinnedTitles.has(sessionId)) return false;
  const threadId = sessionToThread.get(sessionId);
  if (!threadId) return false;
  try {
    const session = await client.getSession(sessionId);
    if (session.parentID) return false;
    if (session.title && shouldPublishOpenCodeTitle(session.title)) {
      return syncSessionTitle(sessionId);
    }
    const messages = await readSessionMessages(
      client,
      sessionId,
      "title",
      TITLE_HISTORY_LIMIT,
    );
    const title = greetingSessionTitle(firstVisibleUserText(messages));
    if (!title) return false;
    debugLog(`title recover ses=${sessionId} ${title}`);
    const updated = await client.updateSession(sessionId, { title });
    const next = updated.title ?? title;
    lastTitles.set(sessionId, next);
    if (!shouldPublishOpenCodeTitle(next)) return false;
    emitDeltas(threadId, [{ kind: "thread.name", name: next }]);
    return true;
  } catch {
    return false;
  }
}

function closeOpeningTurn(threadId: string): void {
  openingTurns.delete(threadId);
  const live = liveTurns.get(threadId);
  if (live) live.pendingPrompts.push(...takeParkedSteers(threadId));
}

function takeParkedSteers(threadId: string): Array<Record<string, unknown>> {
  const parked = parkedSteers.get(threadId);
  parkedSteers.delete(threadId);
  return parked ?? [];
}

function takeQueuedSteer(
  threadId: string,
  live: LiveTurn,
): Record<string, unknown> | undefined {
  const fromLive = live.pendingPrompts.shift();
  if (fromLive) return fromLive;
  const parked = parkedSteers.get(threadId);
  if (!parked?.length) return undefined;
  const next = parked.shift();
  if (parked.length === 0) parkedSteers.delete(threadId);
  return next;
}

let lastMessageIdTimestamp = 0;
let messageIdCounter = 0;

/** OpenCode Identifier.ascending wire format for client-owned prompt boundaries. */
function nextMessageId(): string {
  const now = Date.now();
  if (now !== lastMessageIdTimestamp) {
    lastMessageIdTimestamp = now;
    messageIdCounter = 0;
  }
  messageIdCounter += 1;
  const value = BigInt(now) * 0x1000n + BigInt(messageIdCounter);
  const hex = (value & 0xffffffffffffn).toString(16).padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let random = "";
  for (let index = 0; index < 14; index += 1) {
    random += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `msg_${hex}${random}`;
}

function promptForLiveTurn(
  active: OpenCodeClient,
  sessionId: string,
  live: LiveTurn,
  body: Record<string, unknown>,
  directory?: string,
): Promise<void> {
  const messageID = nextMessageId();
  live.pollUserMessageId = messageID;
  return active.promptAsync(sessionId, { ...body, messageID }, directory);
}

async function flushSteerBody(
  threadId: string,
  sessionId: string,
  active: OpenCodeClient,
  live: LiveTurn,
  queued: Record<string, unknown>,
): Promise<void> {
  try {
    await promptForLiveTurn(
      active,
      sessionId,
      live,
      queued,
      boundDirectory(sessionId),
    );
  } catch (error) {
    live.parentBoundaryEmitted = true;
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
}

function usableSteerLive(
  threadId: string,
  sessionId: string,
): LiveTurn | undefined {
  const live = liveTurns.get(threadId);
  if (
    !live ||
    live.parentBoundaryEmitted ||
    live.stopping ||
    live.sessionId !== sessionId
  ) {
    return undefined;
  }
  return live;
}

function steerPromptBody(args: {
  sessionId: string;
  input: readonly PromptInput[];
  options: unknown;
}): { ok: true; body: Record<string, unknown> } | { ok: false; reason: string } {
  const options = providerOptions(args.options);
  const agent = typeof options.agent === "string" ? options.agent : "build";
  const model =
    typeof (args.options as { model?: unknown })?.model === "string"
      ? ((args.options as { model: string }).model as string)
      : (lastPromptedModels.get(args.sessionId) ?? lastPromptedModel);
  const built = buildPrompt({ agent, input: args.input, model });
  if (!built.ok) return built;
  const variant = openCodeVariantFor(reasoningLevelOf(args.options));
  return {
    ok: true,
    body: { ...built.prompt, ...(variant ? { variant } : {}) },
  };
}

function enqueueSteer(threadId: string, body: Record<string, unknown>): boolean {
  const live = liveTurns.get(threadId);
  if (live && !live.parentBoundaryEmitted) {
    live.pendingPrompts.push(body);
    return true;
  }
  if (openingTurns.has(threadId)) {
    const parked = parkedSteers.get(threadId) ?? [];
    parked.push(body);
    parkedSteers.set(threadId, parked);
    return true;
  }
  return false;
}

async function runSteer(args: {
  threadId: string;
  sessionId: string;
  input: readonly PromptInput[];
  options: unknown;
  clientRequestId?: string;
}): Promise<void> {
  const built = steerPromptBody(args);
  if (!built.ok) {
    emitDeltas(args.threadId, [
      {
        kind: "provider.warning",
        category: "general",
        summary: "Could not deliver follow-up",
        details: built.reason,
        vouchedTurn: true,
      },
    ]);
    return;
  }
  if (args.clientRequestId) {
    emitDeltas(args.threadId, [
      { kind: "input.accepted", clientRequestId: args.clientRequestId },
    ]);
  }
  if (
    steerDeliveryOf(args.options) === "inject" &&
    usableSteerLive(args.threadId, args.sessionId)
  ) {
    const active = await ensureClient();
    // Legacy OpenCode has no live steer primitive. Suppress the abort boundary,
    // wait for its runner to release, then restart inside the current BB turn.
    const live = usableSteerLive(args.threadId, args.sessionId);
    if (!live) return;
    const restart: SteerRestart = {
      expectAbortError: true,
      expectAbortIdle: true,
      promptStarted: false,
    };
    live.steerRestart = restart;
    let aborted = false;
    try {
      await active.abort(args.sessionId);
      aborted = true;
      if (usableSteerLive(args.threadId, args.sessionId) !== live) return;
      await promptForLiveTurn(
        active,
        args.sessionId,
        live,
        built.body,
        boundDirectory(args.sessionId),
      );
      if (usableSteerLive(args.threadId, args.sessionId) !== live) {
        try {
          await active.abort(args.sessionId);
        } catch {
          /* already idle */
        }
        return;
      }
      restart.promptStarted = true;
      clearCompletedSteerRestart(live);
    } catch (error) {
      if (usableSteerLive(args.threadId, args.sessionId) !== live) return;
      live.steerRestart = undefined;
      const details = error instanceof Error ? error.message : String(error);
      if (aborted) {
        failIssuedTurn(args.threadId, `Could not start follow-up: ${details}`);
      } else {
        emitDeltas(args.threadId, [
          {
            kind: "provider.warning",
            category: "general",
            summary: "Could not deliver follow-up",
            details,
            vouchedTurn: true,
          },
        ]);
      }
    }
    return;
  }
  if (enqueueSteer(args.threadId, built.body)) return;
  await runPrompt(args);
}

function rememberPromptedModel(sessionId: string, model: string): void {
  lastPromptedModels.set(sessionId, model);
  lastPromptedModel = model;
}

async function resolvePromptModel(
  sessionId: string,
  options: unknown,
  active: OpenCodeClient,
  preferSession = false,
): Promise<{ ok: true; id?: string } | { ok: false; reason: string }> {
  if (preferSession) {
    try {
      const fromHistory = lastModelIdFromMessages(
        await readSessionMessages(
          active,
          sessionId,
          "model",
          PROMPT_HISTORY_LIMIT,
        ),
      );
      if (fromHistory) {
        rememberPromptedModel(sessionId, fromHistory);
        return { ok: true, id: fromHistory };
      }
    } catch {
      /* history is best-effort */
    }
    return { ok: true };
  }
  const raw =
    typeof (options as { model?: unknown })?.model === "string"
      ? ((options as { model: string }).model as string).trim()
      : undefined;
  const remembered = lastPromptedModels.get(sessionId) ?? lastPromptedModel;
  let providers: Array<{ id: string; models?: unknown }> = [];
  let configured: string | undefined;
  if (raw && !raw.includes("/")) {
    try {
      const catalog = await active.providers();
      providers = catalog.providers ?? [];
    } catch {
      /* catalog is best-effort */
    }
    try {
      configured = configDefaultModelId(await active.getConfig());
    } catch {
      configured = undefined;
    }
  }
  const coerced = coerceModelRef(raw, {
    providers,
    lastPrompted: remembered,
    configured,
  });
  if (coerced) {
    rememberPromptedModel(sessionId, coerced);
    return { ok: true, id: coerced };
  }
  try {
    const fromHistory = lastModelIdFromMessages(
      await readSessionMessages(
        active,
        sessionId,
        "model-fallback",
        PROMPT_HISTORY_LIMIT,
      ),
    );
    if (fromHistory) {
      rememberPromptedModel(sessionId, fromHistory);
      return { ok: true, id: fromHistory };
    }
  } catch {
    /* history is best-effort */
  }
  return { ok: true };
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
  const existing = liveTurns.get(args.threadId);
  if (existing?.promptIssued) {
    const built = steerPromptBody(args);
    if (built.ok) existing.pendingPrompts.push(built.body);
    return;
  }
  if (!existing) {
    attachObservedTurn(args.threadId, args.sessionId);
  }
  const live = liveTurns.get(args.threadId);
  if (!live) return;
  live.promptIssued = true;
  live.pendingPrompts.push(...takeParkedSteers(args.threadId));
  if (args.clientRequestId) {
    emitDeltas(args.threadId, [
      {
        kind: "input.accepted",
        clientRequestId: args.clientRequestId,
      },
    ]);
  }

  let active: OpenCodeClient;
  try {
    active = await ensureClient();
  } catch (error) {
    failIssuedTurn(
      args.threadId,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  let priorMessages: HydrateMessage[] | undefined;
  try {
    priorMessages = await readSessionMessages(
      active,
      args.sessionId,
      "prompt",
      PROMPT_HISTORY_LIMIT,
    );
  } catch {
    /* history is best-effort */
  }
  const options = providerOptions(args.options);
  const requested =
    typeof options.agent === "string" ? options.agent : undefined;
  const resolved = await resolveSelectableAgent({
    active,
    requested,
    sessionId: args.sessionId,
  });
  if (!resolved.ok) {
    failIssuedTurn(args.threadId, resolved.reason);
    return;
  }
  const bound = sessions.get(args.threadId);
  const model = await resolvePromptModel(
    args.sessionId,
    args.options,
    active,
    resolved.inheritSession,
  );
  if (!model.ok) {
    failIssuedTurn(args.threadId, model.reason);
    return;
  }
  const built = buildPrompt({
    agent: resolved.agent,
    input: args.input,
    model: model.id,
    instructions:
      bound?.instructions ?? instructionsOf(args.options),
  });
  if (!built.ok) {
    failIssuedTurn(args.threadId, built.reason);
    return;
  }
  try {
    const variant = resolved.inheritSession
      ? lastVariantFromMessages(
          priorMessages ??
            (await readSessionMessages(
              active,
              args.sessionId,
              "variant",
              PROMPT_HISTORY_LIMIT,
            )),
        )
      : openCodeVariantFor(reasoningLevelOf(args.options));
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
        await active.sessionCommand(
          args.sessionId,
          {
            command: matched.name,
            arguments: slash.arguments,
            agent: built.prompt.agent,
            ...(variant ? { variant } : {}),
          },
          cwd,
        );
        await settleIssuedTurn(args.threadId, args.sessionId, active);
        return;
      }
    }
    const appendix = formatSkillAppendix(configuredSkillRoots);
    const system = [built.prompt.system, appendix].filter(Boolean).join("\n\n");
    const prompt = system
      ? { ...built.prompt, system }
      : built.prompt;
    await promptForLiveTurn(
      active,
      args.sessionId,
      live,
      {
        ...prompt,
        ...(variant ? { variant } : {}),
      },
      sessions.get(args.threadId)?.cwd,
    );
  } catch (error) {
    failIssuedTurn(
      args.threadId,
      error instanceof Error ? error.message : String(error),
    );
    try {
      await replayHydrate(args.threadId, args.sessionId, active);
    } catch {
      /* restore is best-effort */
    }
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
      if (pending?.status !== "pending") return;
      const active = client;
      if (!active) {
        pendingQuestion.delete(id);
        failIssuedTurn(
          pending.threadId,
          "OpenCode disconnected before the question was answered",
        );
        return;
      }
      pending.status = "answering";
      const resolution =
        result && typeof result === "object"
          ? (result as {
              kind?: unknown;
              answers?: Record<string, { selected?: string[]; freeText?: string }>;
            })
          : undefined;
      const settle =
        resolution?.kind === "user_answer"
          ? active.replyQuestion({
              requestID: pending.requestId,
              sessionID: pending.sessionId,
              answers: answersForOpenCode(pending.payload, resolution),
              directory: boundDirectory(pending.sessionId),
            })
          : active.rejectQuestion({
              requestID: pending.requestId,
              sessionID: pending.sessionId,
              directory: boundDirectory(pending.sessionId),
            });
      void settle
        .then(() => {
          pending.status = "settled";
        })
        .catch(async (cause) => {
          pendingQuestion.delete(id);
          await active
            .rejectQuestion({
              requestID: pending.requestId,
              sessionID: pending.sessionId,
              directory: boundDirectory(pending.sessionId),
            })
            .catch(() => undefined);
          failIssuedTurn(
            pending.threadId,
            `Could not answer OpenCode question: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        });
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
              directory: boundDirectory(pending.sessionId),
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

function disposeBridgeRuntime(): void {
  titleWatchEpoch += 1;
  if (titleTimer) {
    clearInterval(titleTimer);
    titleTimer = undefined;
  }
  dropSubscriptions();
  sessions.clear();
  sessionToThread.clear();
  liveTurns.clear();
  openingTurns.clear();
  parkedSteers.clear();
  pendingPermission.clear();
  pendingQuestion.clear();
  lastTitles.clear();
  userPinnedTitles.clear();
  lastRevertCursors.clear();
  lastTodos.clear();
  compactIssued.clear();
  compactInFlight.clear();
  pollInFlight.clear();
  emptyAskStreak.clear();
  lastPermissionCount.clear();
  lastHistoryMetricAt.clear();
  lastHistoryRssMb.clear();
  modelContextWindows.clear();
  lastPromptedModels.clear();
  lastPromptedModel = undefined;
  reconnecting = false;
  client = undefined;
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    dataDir = context.dataDir;
  },
  onClose: disposeBridgeRuntime,
  onSigterm: disposeBridgeRuntime,
  onSigint: disposeBridgeRuntime,
});
