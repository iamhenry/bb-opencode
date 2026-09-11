import { acquireClient, createSdkClient, type OpenCodeClient } from "./client.js";
import {
  coerceModelRef,
  configDefaultModelId,
  lastModelIdFromMessages,
  lastVariantFromMessages,
  listAuthenticatedProviders,
} from "./catalog.js";
import {
  lastAgent,
  lastUserAgent,
  revertMessageIdOf,
  type HydrateMessage,
} from "./hydrate.js";
import { messageMetaFromInfo } from "./run-chip.js";
import { readCompleteHistory } from "./history-pages.js";
import {
  attachOrSpawn,
  launchGuardBlockMessage,
  pidAlive,
  portListening,
  readLaunchClaim,
  readLock,
  recentServeLog,
  spawnOwnership,
  stopServeIf,
} from "./process.js";
import {
  acquireExclusive,
  exclusiveKind,
  holdBlockMessage,
  releaseExclusive,
} from "./hold.js";
import { probeOpenCode, type ProbeResult } from "./probe.js";
import { recentUnknownLogLines } from "./bridge.js";
import { resolveRevertMessageId } from "./revert-target.js";
import {
  buildOpenCodeRevertState,
  type RevertStateMessage,
} from "./revert-state.js";
import { splitModelRef } from "./task-thread.js";
import { runningSessionIdsFromStatus } from "./session-status.js";
import { listLiveTaskChildren } from "./task-live.js";
import { writeLivePermissionMode } from "./permission-mode-live.js";
import type { LivePermissionMode } from "./permission-mode.js";
import {
  bbSessionsIdle,
  emptyUpdateStatus,
  readUpdateStatus,
  restartToApply,
} from "./update.js";
import { bbReasoningLevelForVariant } from "./reasoning.js";

const clients = new Map<string, OpenCodeClient>();

function acquire(url: string): OpenCodeClient {
  return acquireClient(createSdkClient, clients, url);
}

export function evictClientsForTests(): void {
  clients.clear();
}

export async function handleProbe(dataDir: string): Promise<ProbeResult> {
  return probeOpenCode({ dataDir, acquire });
}

export async function handleReload(
  dataDir: string,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const blocked = holdBlockMessage();
    if (blocked) {
      return { ok: false, error: blocked };
    }
    const token = acquireExclusive("restart");
    if (!token) {
      return {
        ok: false,
        error: `OpenCode ${exclusiveKind() ?? "restart"} already in progress`,
      };
    }
    try {
      const guardMsg = launchGuardBlockMessage();
      if (guardMsg) return { ok: false, error: guardMsg };
      const lock = readLock(dataDir);
      if (!lock) return { ok: false, error: "No BB-owned OpenCode lock" };
      const claim = readLaunchClaim();
      const owned = spawnOwnership(
        lock.pid,
        lock.port,
        lock.startedAt,
        claim?.token,
      );
      if (!owned.ok || !claim?.token) {
        return { ok: false, error: owned.ok ? "OpenCode pid is not a BB-launched serve" : owned.error };
      }
      if (!pidAlive(lock.pid)) {
        return { ok: false, error: "BB OpenCode lock pid is not alive" };
      }
      if (!(await portListening(lock.port))) {
        return { ok: false, error: "BB OpenCode server health is unknown" };
      }
      const idle = await bbSessionsIdle(lock.port);
      if (idle !== true) {
        return {
          ok: false,
          error:
            idle === false
              ? "OpenCode sessions are busy"
              : "BB session idleness is unknown",
        };
      }
      const stop = await stopServeIf(dataDir, lock, claim.token);
      if (stop !== "stopped") {
        return {
          ok: false,
          error:
            stop === "replaced"
              ? "OpenCode lock was replaced; not signaling the new pid"
              : stop === "unowned"
                ? (launchGuardBlockMessage() ??
                  "OpenCode pid is not a BB-launched serve")
                : stop === "alive"
                  ? "OpenCode serve did not exit"
                  : "BB OpenCode lock disappeared before reload",
        };
      }
      return { ok: true, error: null };
    } finally {
      releaseExclusive(token);
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleLogs(limit = 80): Promise<{ lines: string[] }> {
  const serve = recentServeLog(Math.min(40, limit)).map((line) => `serve ${line}`);
  const events = recentUnknownLogLines();
  return { lines: [...serve, ...events].slice(-limit) };
}

export async function handleListSessions(
  dataDir: string,
  parentSessionId?: string,
) {
  let attached;
  try {
    attached = await attachOrSpawn({ dataDir, spawn: false });
  } catch {
    return { sessions: [] };
  }
  const client = acquire(attached.url);
  let directory: string | undefined;
  let sessions;
  if (parentSessionId) {
    try {
      directory = (await client.getSession(parentSessionId)).directory;
    } catch {
      directory = undefined;
    }
    sessions = await client.sessionChildren(parentSessionId, directory);
  } else {
    sessions = await client.listSessions();
  }
  let statuses = new Set<string>();
  try {
    const query = directory
      ? `?directory=${encodeURIComponent(directory)}`
      : "";
    const response = await fetch(`${attached.url}/session/status${query}`);
    if (response.ok) {
      statuses = runningSessionIdsFromStatus((await response.json()) as unknown);
    }
  } catch {
    /* status is best-effort */
  }
  const mapped = sessions.map((session) => ({
    id: session.id,
    title: session.title ?? null,
    directory: session.directory ?? null,
    parentID: session.parentID ?? null,
    running: statuses.has(session.id),
  }));
  const byId = new Map(mapped.map((session) => [session.id, session]));
  for (const live of listLiveTaskChildren(parentSessionId)) {
    const existing = byId.get(live.childSessionId);
    if (existing) {
      existing.running = existing.running || live.running;
      if (!existing.title && live.title) existing.title = live.title;
      continue;
    }
    byId.set(live.childSessionId, {
      id: live.childSessionId,
      title: live.title,
      directory: null,
      parentID: live.parentSessionId,
      running: live.running,
    });
  }
  return { sessions: [...byId.values()] };
}

export async function handleListCommands(
  dataDir: string,
  directory?: string,
) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  const commands = await client.listCommands(directory);
  return {
    commands: commands
      .filter((command) => typeof command.name === "string" && command.name.length > 0)
      .map((command) => ({
        name: command.name,
        description:
          typeof command.description === "string" ? command.description : null,
      })),
  };
}

export async function handleListAgents(dataDir: string) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  const agents = await client.agents();
  return {
    agents: agents.map((agent) => ({
      name: agent.name,
      mode: agent.mode ?? null,
      hidden: agent.hidden === true,
      description: agent.description ?? null,
    })),
  };
}

const SNAPSHOT_HISTORY_LIMIT = 100;
const RUN_CHIP_HISTORY_LIMIT = 500;

export async function handleSessionSnapshot(dataDir: string, sessionId: string) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  const session = await client.getSession(sessionId);
  const messages = (await client.sessionMessages(
    sessionId,
    SNAPSHOT_HISTORY_LIMIT,
  )) as HydrateMessage[];
  const rawModel = lastModelIdFromMessages(messages);
  let model = rawModel;
  if (rawModel) {
    try {
      model = coerceModelRef(rawModel, {
        providers: listAuthenticatedProviders(await client.providers()),
      });
    } catch {
      // Catalog lookup is best-effort; retain the session model when unavailable.
    }
  }
  return {
    id: session.id,
    title: session.title ?? null,
    directory: session.directory ?? null,
    parentID: session.parentID ?? null,
    lastUserAgent: lastAgent(messages) ?? null,
    model: model ?? null,
    reasoningLevel:
      bbReasoningLevelForVariant(lastVariantFromMessages(messages)) ?? null,
  };
}

const REVERT_SETTLE_TIMEOUT_MS = 15_000;
const REVERT_SETTLE_POLL_MS = 100;

async function settleOpenCodeSession(
  client: OpenCodeClient,
  sessionId: string,
): Promise<void> {
  if (!(await client.sessionIsRunning(sessionId))) return;
  await client.abort(sessionId);
  const deadline = Date.now() + REVERT_SETTLE_TIMEOUT_MS;
  while (await client.sessionIsRunning(sessionId)) {
    if (Date.now() >= deadline) {
      throw new Error("OpenCode session did not settle before revert");
    }
    await new Promise((resolve) => setTimeout(resolve, REVERT_SETTLE_POLL_MS));
  }
}

export async function handleSettleSession(dataDir: string, sessionId: string) {
  try {
    const attached = await attachOrSpawn({ dataDir });
    const client = acquire(attached.url);
    await settleOpenCodeSession(client, sessionId);
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleRevert(
  dataDir: string,
  sessionId: string,
  target?: { messageID?: string; role?: "user" | "assistant"; text?: string },
) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  await settleOpenCodeSession(client, sessionId);
  const messages = (await readCompleteHistory(client, sessionId)).messages as Array<{
    info: { id?: string; role?: string };
    parts: Array<{ type?: string; text?: string }>;
  }>;
  const messageID = resolveRevertMessageId({
    messages,
    messageID: target?.messageID,
    role: target?.role,
    text: target?.text,
  });
  if (!messageID) {
    return { ok: false, error: "Could not uniquely match that message" };
  }
  await client.revert(sessionId, { messageID });
  return { ok: true, error: null };
}

export async function handleUnrevert(dataDir: string, sessionId: string) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  await settleOpenCodeSession(client, sessionId);
  await client.unrevert(sessionId);
  return { ok: true, error: null };
}

export async function handleRevertState(dataDir: string, sessionId: string) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  const [session, complete] = await Promise.all([
    client.getSession(sessionId),
    readCompleteHistory(client, sessionId),
  ]);
  return buildOpenCodeRevertState({
    revertMessageID: revertMessageIdOf(session),
    messages: complete.messages as RevertStateMessage[],
  });
}

export async function handleListMessageMeta(dataDir: string, sessionId: string) {
  let attached;
  try {
    attached = await attachOrSpawn({ dataDir, spawn: false });
  } catch {
    return { messages: [] };
  }
  const client = acquire(attached.url);
  // BB paints at most two recent timeline pages, so older provider metadata
  // cannot be matched and must not force a complete-session materialization.
  const messages = await client.sessionMessages(sessionId, RUN_CHIP_HISTORY_LIMIT);
  return {
    messages: messages.flatMap((message) => {
      const meta = messageMetaFromInfo(message.info);
      return meta ? [meta] : [];
    }),
  };
}

export async function handleSummarize(
  dataDir: string,
  sessionId: string,
  model?: string,
) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  if (await client.sessionIsRunning(sessionId)) {
    return { ok: false, error: "Cannot summarize a running session" };
  }
  const parsed =
    splitModelRef(model) ??
    splitModelRef(configDefaultModelId(await client.getConfig()));
  if (!parsed) {
    return { ok: false, error: "No OpenCode model available to summarize" };
  }
  await client.summarize(sessionId, parsed);
  return { ok: true, error: null };
}

export function currentLock(dataDir: string) {
  return readLock(dataDir);
}

export function handleStampPermissionMode(
  dataDir: string,
  threadId: string,
  permissionMode: LivePermissionMode,
): { ok: boolean } {
  writeLivePermissionMode(dataDir, threadId, permissionMode);
  return { ok: true };
}

export async function handleUpdateStatus(dataDir: string) {
  try {
    return await readUpdateStatus(dataDir);
  } catch (error) {
    return emptyUpdateStatus(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function handleRestartToApply(dataDir: string) {
  return restartToApply(dataDir);
}
