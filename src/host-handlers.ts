import { acquireClient, createSdkClient, type OpenCodeClient } from "./client.js";
import { configDefaultModelId } from "./catalog.js";
import { lastUserAgent, type HydrateMessage } from "./hydrate.js";
import { attachOrSpawn, readLock, recentServeLog } from "./process.js";
import { probeOpenCode, type ProbeResult } from "./probe.js";
import { recentUnknownLogLines } from "./bridge.js";
import { resolveRevertMessageId } from "./revert-target.js";
import { splitModelRef } from "./task-thread.js";

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
  let sessions;
  if (parentSessionId) {
    let directory: string | undefined;
    try {
      directory = (await client.getSession(parentSessionId)).directory;
    } catch {
      directory = undefined;
    }
    sessions = await client.sessionChildren(parentSessionId, directory);
  } else {
    sessions = await client.listSessions();
  }
  const statuses = new Set<string>();
  try {
    const response = await fetch(`${attached.url}/session/status`);
    if (response.ok) {
      const body = (await response.json()) as unknown;
      if (Array.isArray(body)) {
        for (const item of body) {
          if (
            item &&
            typeof item === "object" &&
            typeof (item as { id?: unknown }).id === "string"
          ) {
            const status = (item as { status?: unknown }).status;
            if (status && status !== "idle") {
              statuses.add((item as { id: string }).id);
            }
          }
        }
      } else if (body && typeof body === "object") {
        for (const [id, value] of Object.entries(body as Record<string, unknown>)) {
          if (value && value !== "idle") statuses.add(id);
        }
      }
    }
  } catch {
    /* status is best-effort */
  }
  return {
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title ?? null,
      directory: session.directory ?? null,
      parentID: session.parentID ?? null,
      running: statuses.has(session.id),
    })),
  };
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

export async function handleSessionSnapshot(dataDir: string, sessionId: string) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  const session = await client.getSession(sessionId);
  const messages = (await client.sessionMessages(sessionId)) as HydrateMessage[];
  return {
    id: session.id,
    title: session.title ?? null,
    directory: session.directory ?? null,
    parentID: session.parentID ?? null,
    lastUserAgent: lastUserAgent(messages) ?? null,
  };
}

export async function handleRevert(
  dataDir: string,
  sessionId: string,
  target?: { messageID?: string; role?: "user" | "assistant"; text?: string },
) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  const messages = (await client.sessionMessages(sessionId)) as Array<{
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
    return { ok: false, error: "Could not match that message" };
  }
  await client.revert(sessionId, { messageID });
  return { ok: true, error: null };
}

export async function handleUnrevert(dataDir: string, sessionId: string) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  await client.unrevert(sessionId);
  return { ok: true, error: null };
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
