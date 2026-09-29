import {
  acquireClient,
  createSdkClient,
  type OpenCodeClient,
  type OpenCodeSession,
} from "./client.js";
import {
  configDefaultModelId,
  lastModelIdFromMessages,
  lastVariantFromMessages,
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
  activeSessionIds,
  attachOrSpawn,
  recentServeLog,
  resolveOpenCodeBinary,
  restartService,
  serviceInfo,
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
      const info = await serviceInfo();
      if (!info) return { ok: false, error: "OpenCode service is not running" };
      const idle = await bbSessionsIdle(info.url);
      if (idle !== true) {
        return {
          ok: false,
          error:
            idle === false
              ? "OpenCode sessions are busy"
              : "BB session idleness is unknown",
        };
      }
      await restartService(resolveOpenCodeBinary() ?? "opencode");
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
  const statuses = (await activeSessionIds(attached.url)) ?? new Set<string>();
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
  return {
    id: session.id,
    title: session.title ?? null,
    directory: session.directory ?? null,
    parentID: session.parentID ?? null,
    lastUserAgent: lastAgent(messages) ?? null,
    model: lastModelIdFromMessages(messages) ?? null,
    reasoningLevel:
      bbReasoningLevelForVariant(lastVariantFromMessages(messages)) ?? null,
  };
}

const REVERT_SETTLE_TIMEOUT_MS = 15_000;
const REVERT_SETTLE_POLL_MS = 100;
type TimedRevertMessage = HydrateMessage & {
  info: HydrateMessage["info"] & { time?: { created?: unknown } };
};

function createdAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstUserMessageId(messages: readonly TimedRevertMessage[]): string | undefined {
  const id = messages.find((message) => message.info.role === "user")?.info.id;
  return typeof id === "string" &&
    messages.filter((message) => message.info.id === id).length === 1
    ? id
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectDescendants(
  client: OpenCodeClient,
  parentId: string,
  seen = new Set<string>([parentId]),
): Promise<OpenCodeSession[]> {
  const descendants: OpenCodeSession[] = [];
  for (const child of await client.sessionChildren(parentId)) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    descendants.push(...(await collectDescendants(client, child.id, seen)));
    descendants.push(child);
  }
  return descendants;
}

async function settleOpenCodeSession(
  client: OpenCodeClient,
  sessionId: string,
): Promise<void> {
  if (!(await client.sessionIsRunning(sessionId))) return;
  const session = await client.getSession(sessionId);
  await client.abort(sessionId, session.directory);
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
  try {
    const attached = await attachOrSpawn({ dataDir });
    const client = acquire(attached.url);
    await settleOpenCodeSession(client, sessionId);
    const messages = (await readCompleteHistory(client, sessionId))
      .messages as TimedRevertMessage[];
    const messageID = resolveRevertMessageId({
      messages,
      messageID: target?.messageID,
      role: target?.role,
      text: target?.text,
    });
    if (!messageID) {
      return { ok: false, error: "Could not uniquely match that message" };
    }

    const descendants = await collectDescendants(client, sessionId);
    const targetTime = createdAt(
      messages.find((message) => message.info.id === messageID)?.info.time?.created,
    );
    if (descendants.length > 0 && targetTime === undefined) {
      return {
        ok: false,
        error: "Could not determine the reverted message time for descendant sessions",
      };
    }

    const applicableChildren: OpenCodeSession[] = [];
    for (const child of descendants) {
      const childCreated = createdAt(child.time?.created);
      if (childCreated === undefined) {
        return { ok: false, error: `Could not determine when descendant session ${child.id} started` };
      }
      if (targetTime !== undefined && childCreated < targetTime) continue;
      applicableChildren.push(child);
    }

    const alreadyStaged = applicableChildren.find((child) => revertMessageIdOf(child));
    if (alreadyStaged) {
      return {
        ok: false,
        error: `Descendant session ${alreadyStaged.id} already has a staged revert`,
      };
    }

    for (const child of applicableChildren) await settleOpenCodeSession(client, child.id);

    const childTargets: Array<{ sessionId: string; messageID: string }> = [];
    for (const child of applicableChildren) {
      const childMessages = (await readCompleteHistory(client, child.id))
        .messages as TimedRevertMessage[];
      const childMessageID = firstUserMessageId(childMessages);
      if (!childMessageID) {
        return {
          ok: false,
          error: `Could not uniquely identify the first user message in descendant session ${child.id}`,
        };
      }
      childTargets.push({ sessionId: child.id, messageID: childMessageID });
    }

    const staged: string[] = [];
    try {
      for (const child of childTargets) {
        await client.revert(child.sessionId, { messageID: child.messageID });
        staged.push(child.sessionId);
      }
      await client.revert(sessionId, { messageID });
      return { ok: true, error: null };
    } catch (error) {
      const cleanupErrors: string[] = [];
      for (const stagedSessionId of staged.reverse()) {
        try {
          await client.unrevert(stagedSessionId);
        } catch (cleanupError) {
          cleanupErrors.push(`${stagedSessionId}: ${errorMessage(cleanupError)}`);
        }
      }
      const detail = errorMessage(error);
      return {
        ok: false,
        error: cleanupErrors.length
          ? `${detail}; failed to clear staged descendants (${cleanupErrors.join("; ")})`
          : detail,
      };
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function handleUnrevert(dataDir: string, sessionId: string) {
  return handleStagedRevertMutation(dataDir, sessionId, "clear");
}

export async function handleRevertCommit(dataDir: string, sessionId: string) {
  return handleStagedRevertMutation(dataDir, sessionId, "commit");
}

async function handleStagedRevertMutation(
  dataDir: string,
  sessionId: string,
  mutation: "clear" | "commit",
) {
  try {
    const attached = await attachOrSpawn({ dataDir });
    const client = acquire(attached.url);
    const descendants = await collectDescendants(client, sessionId);
    await settleOpenCodeSession(client, sessionId);
    const parent = await client.getSession(sessionId);
    const stagedDescendants = await ownedStagedDescendants(
      client,
      sessionId,
      descendants,
      revertMessageIdOf(parent),
    );
    for (const child of stagedDescendants) await settleOpenCodeSession(client, child.id);
    for (const child of stagedDescendants) {
      if (mutation === "clear") await client.unrevert(child.id);
      else await client.revertCommit(child.id);
    }
    if (mutation === "clear") await client.unrevert(sessionId);
    else await client.revertCommit(sessionId);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function ownedStagedDescendants(
  client: OpenCodeClient,
  parentSessionId: string,
  descendants: OpenCodeSession[],
  parentMessageID?: string,
): Promise<OpenCodeSession[]> {
  if (!parentMessageID || descendants.length === 0) return [];

  const parentMessages = (await readCompleteHistory(client, parentSessionId))
    .messages as TimedRevertMessage[];
  const parentMatches = parentMessages.filter((message) => message.info.id === parentMessageID);
  if (parentMatches.length !== 1) {
    throw new Error("Could not uniquely identify the parent staged message");
  }
  const targetTime = createdAt(parentMatches[0]?.info.time?.created);
  if (targetTime === undefined) {
    throw new Error("Could not determine the parent staged message time");
  }

  const owned: OpenCodeSession[] = [];
  for (const child of descendants) {
    const childCreated = createdAt(child.time?.created);
    if (childCreated === undefined) {
      throw new Error(`Could not determine when descendant session ${child.id} started`);
    }
    if (childCreated < targetTime) continue;
    const stagedMessageID = revertMessageIdOf(child);
    if (!stagedMessageID) continue;
    const childMessages = (await readCompleteHistory(client, child.id))
      .messages as TimedRevertMessage[];
    if (firstUserMessageId(childMessages) === stagedMessageID) owned.push(child);
  }
  return owned;
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
