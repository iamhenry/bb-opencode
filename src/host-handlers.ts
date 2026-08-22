import { acquireClient, createSdkClient, type OpenCodeClient } from "./client.js";
import { lastUserAgent, type HydrateMessage } from "./hydrate.js";
import { attachOrSpawn, readLock } from "./process.js";
import { probeOpenCode, type ProbeResult } from "./probe.js";
import { hydrateBoundSession, recentUnknownLogLines } from "./bridge.js";

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
  return { lines: recentUnknownLogLines().slice(-limit) };
}

export async function handleListSessions(dataDir: string) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  const sessions = await client.listSessions();
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
  messageID?: string,
) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  await client.revert(sessionId, messageID ? { messageID } : {});
  await hydrateBoundSession(sessionId);
  return { ok: true };
}

export async function handleUnrevert(dataDir: string, sessionId: string) {
  const attached = await attachOrSpawn({ dataDir });
  const client = acquire(attached.url);
  await client.unrevert(sessionId);
  await hydrateBoundSession(sessionId);
  return { ok: true };
}

export function currentLock(dataDir: string) {
  return readLock(dataDir);
}
