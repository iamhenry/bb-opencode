import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract } from "./contract.js";
import {
  createAgentStampStore,
  peekAgent,
  settleTurn,
  stampAgent,
} from "./src/agent-stamp.js";
import { PROVIDER_DISPLAY_NAME, PROVIDER_ID, SDK_PIN } from "./src/identity.js";
import {
  resolveImportEnvironment,
  type ImportProject,
} from "./src/import-environment.js";
import {
  armNextAdopt,
  consumeNextAdopt,
  createNextAdoptStore,
  disarmNextAdopt,
} from "./src/next-adopt.js";
import {
  armNextAgent,
  consumeNextAgent,
  createNextAgentStore,
  resolveComposerProvider,
  resolvePromptAgent,
} from "./src/next-agent.js";
import {
  pendingAdoptStorageKey,
  type PendingAdoptRecord,
} from "./src/pending-adopt.js";
import { classifyImportRow } from "./src/import-row.js";
import { listAgentMentions, mentionResolveContext } from "./src/mentions.js";
import { persistPublishedOpenCodeTitle } from "./src/session-title.js";
import { sessionIdFromThreadEvents } from "./src/session-bind.js";
import {
  shouldAutoBindTaskChild,
  taskChildBindInput,
  taskChildThreadTitle,
} from "./src/task-thread.js";
import {
  hydratePickerAgent,
  listSelectablePrimaries,
  type OpenCodeAgent,
} from "./src/selectable-primaries.js";

const stamps = createAgentStampStore();
const nextAdopts = createNextAdoptStore();
const nextAgents = createNextAgentStore();
const seenThreadIds = new Set<string>();
let steerActiveThreadOnEnter = false;
const taskPollTimers = ((globalThis as {
  __ocTaskPollTimers?: Set<ReturnType<typeof setInterval>>;
}).__ocTaskPollTimers ??= new Set());

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const settings = bb.settings.define({
    defaultAgent: {
      type: "select",
      label: "Default OpenCode agent",
      description:
        "Used on new OpenCode threads. The iOS app has no in-composer Agent chip; change it here. Desktop/PWA show the chip when OpenCode is selected.",
      options: ["build", "plan", "orchestrator"],
      default: "build",
    },
  });
  let configuredAgent = "build";
  const readConfiguredAgent = async () => {
    const current = await settings.get();
    configuredAgent =
      typeof current.defaultAgent === "string" && current.defaultAgent.trim()
        ? current.defaultAgent.trim()
        : "build";
  };
  await readConfiguredAgent();
  settings.onChange(() => {
    void readConfiguredAgent();
  });
  const refreshSteerSetting = async () => {
    try {
      const config = await bb.sdk.system.config();
      steerActiveThreadOnEnter = Boolean(
        config.generalSettings.steerActiveThreadOnEnter,
      );
    } catch {
      steerActiveThreadOnEnter = false;
    }
  };
  await refreshSteerSetting();
  bb.sdk.subscribe({
    event: "system:config-changed",
    callback: () => {
      void refreshSteerSetting();
    },
  });

  bb.agents.experimental_registerProvider({
    id: PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    icon: "./assets/icon.svg",
    capabilities: {
      experimental_providerHealth: true,
      experimental_providerUsage: true,
      experimental_providerInstallation: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high"],
    },
    composerActions: [],
    experimental_visibility: "always",
    experimental_strings: {
      signInHint: "Run `opencode auth` on this machine, then send again.",
      expiredHint: "OpenCode auth expired. Run `opencode auth` and send again.",
      installUrl: "https://opencode.ai/docs",
      brandPrefix: "OpenCode ",
    },
    experimental_env: { passthrough: ["OPENCODE_BIN"] },
    experimental_deriveProviderOptions(ctx) {
      const stamped = peekAgent(stamps, ctx.threadId);
      const agent = resolvePromptAgent({
        stamped,
        next: stamped
          ? undefined
          : consumeNextAgent(nextAgents, ctx.projectId),
        configured: configuredAgent,
      });
      const isNewThread = !seenThreadIds.has(ctx.threadId);
      seenThreadIds.add(ctx.threadId);
      const adopt = consumeNextAdopt(nextAdopts, {
        projectId: ctx.projectId,
        isNewThread,
      });
      return {
        agent,
        ...(adopt
          ? {
              adoptSessionId: adopt.opencodeSessionId,
              ...(adopt.bindOnly ? { bindOnly: true } : {}),
            }
          : {}),
        permissionMode: ctx.permissionMode,
        steerDelivery: steerActiveThreadOnEnter ? "inject" : "queue",
      };
    },
  });

  bb.events.on("thread.idle", ({ thread }) => {
    settleTurn(stamps, thread.id);
    schedulePublishedTitlePersist(bb, thread);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    settleTurn(stamps, thread.id);
    schedulePublishedTitlePersist(bb, thread);
  });

  bb.rpc.register(rpcContract, {
    async threadProvider({ threadId }) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return { providerId: thread.providerId ?? null };
      } catch {
        return { providerId: null };
      }
    },
    async probe() {
      const hostId = await firstHostId(bb);
      if (!hostId) {
        return {
          binaryPath: null,
          serverVersion: null,
          attached: false,
          spawned: false,
          port: null,
          pid: null,
          supportedRange: "",
          sdkPin: SDK_PIN,
          authError: null,
          error: "No enrolled host",
          needsConfiguration: true,
          serveCwd: null,
          configSummary: null,
          serveLog: [],
        };
      }
      const result = await host.call("probe", {}, { hostId });
      if (result.needsConfiguration) {
        bb.status.needsConfiguration(
          result.error ??
            "OpenCode is missing or outside the pinned version window.",
        );
      }
      return result;
    },
    async stampAgent(input) {
      if (input.threadId) {
        stampAgent(stamps, {
          threadId: input.threadId,
          agent: input.agent,
          queued: input.queued,
        });
      } else if (input.projectId) {
        armNextAgent(nextAgents, input.projectId, input.agent);
      }
      return { ok: true };
    },
    async composerChrome({ threadId, projectId }) {
      return loadComposerChrome(bb, host, { threadId, projectId });
    },
    async hydratePicker({ threadId }) {
      try {
        const thread = threadFields(await bb.sdk.threads.get({ threadId }));
        const hostId = await resolveHostId(bb, thread.environmentId);
        if (!hostId || thread.providerId !== PROVIDER_ID) {
          return {
            status: "hidden" as const,
            agent: "",
            options: [],
            error: null,
          };
        }
        const agents = await loadAgents(host, hostId);
        const sessionId = await resolveSessionId(
          bb,
          threadId,
          thread.providerThreadId,
        );
        const lastUserAgent = sessionId
          ? (
              await host.call(
                "sessionSnapshot",
                { sessionId },
                { hostId },
              )
            ).lastUserAgent
          : null;
        const hydrated = hydratePickerAgent({
          lastUserAgent: lastUserAgent ?? undefined,
          agents,
        });
        const options = listSelectablePrimaries(agents).map((agent) => ({
          name: agent.name,
          description: agent.description ?? null,
        }));
        if (hydrated.status === "unknown") {
          return {
            status: "unknown" as const,
            agent: hydrated.agent,
            options,
            error: `Unknown OpenCode agent: ${hydrated.agent}. Pick a listed agent before sending.`,
          };
        }
        return {
          status: hydrated.status,
          agent: hydrated.agent,
          options,
          error: null,
        };
      } catch (error) {
        return {
          status: "hidden" as const,
          agent: "",
          options: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async listImport() {
      bb.log.info("import.list");
      const hostId = await firstHostId(bb);
      if (!hostId) return { hostId: null, sessions: [] };
      const listed = await host.call("listSessions", {}, { hostId });
      const threads = await bb.sdk.threads.list({
        includeHidden: true,
        limit: 200,
      });
      const imported = new Set(
        threads
          .map((thread) => threadFields(thread))
          .filter(
            (thread) =>
              thread.providerId === PROVIDER_ID && thread.providerThreadId,
          )
          .map((thread) => thread.providerThreadId as string),
      );
      return {
        hostId,
        sessions: listed.sessions.map((session) => {
          const classified = classifyImportRow({
            id: session.id,
            directory: session.directory,
            running: session.running,
            importedIds: imported,
          });
          return {
            id: session.id,
            title: session.title,
            directory: session.directory,
            parentID: session.parentID,
            blocked: classified.blocked,
            blockReason: classified.blockReason,
            alreadyImported: classified.alreadyImported,
          };
        }),
      };
    },
    async confirmImport({ projectId, hostId, sessionIds }) {
      const resolvedHostId = (await firstHostId(bb)) ?? hostId;
      let written = 0;
      for (const sessionId of sessionIds) {
        const record: PendingAdoptRecord = {
          projectId,
          hostId: resolvedHostId,
          opencodeSessionId: sessionId,
          createdAt: Date.now(),
        };
        await bb.storage.kv.set(pendingAdoptStorageKey(record), record);
        written += 1;
      }
      return { written };
    },
    async openImported(input) {
      const hostId = (await firstHostId(bb)) ?? input.hostId;
      const pending = await bb.storage.kv.get<PendingAdoptRecord>(
        pendingAdoptStorageKey({
          projectId: input.projectId,
          hostId,
          opencodeSessionId: input.sessionId,
        }),
      );
      if (!pending) {
        throw new Error("No pending adopt for that session");
      }
      const listed = await host.call("listSessions", {}, { hostId });
      const row = listed.sessions.find((session) => session.id === input.sessionId);
      if (row?.running) {
        throw new Error("Cannot open a running OpenCode session");
      }
      const snapshot = await host.call(
        "sessionSnapshot",
        { sessionId: input.sessionId },
        { hostId },
      );
      const decision = await decideImportTarget(bb, {
        hostId,
        currentProjectId: input.projectId,
        directory: snapshot.directory ?? "",
      });
      const parentThread = snapshot.parentID
        ? (await listProjectThreads(bb))
            .map((thread) => fullThreadFields(thread))
            .find(
              (thread) =>
                thread.providerId === PROVIDER_ID &&
                thread.providerThreadId === snapshot.parentID &&
                thread.id,
            )
        : undefined;
      if (parentThread?.id && parentThread.projectId) {
        const threadId = await spawnBoundTaskChild(bb, {
          projectId: parentThread.projectId,
          hostId,
          parentThreadId: parentThread.id,
          environmentId: parentThread.environmentId,
          sessionId: input.sessionId,
          title: snapshot.title,
          bindOnly: true,
        });
        await bb.storage.kv.delete(
          pendingAdoptStorageKey({
            projectId: input.projectId,
            hostId,
            opencodeSessionId: input.sessionId,
          }),
        );
        return { threadId };
      }
      armNextAdopt(nextAdopts, {
        projectId: decision.projectId,
        hostId,
        opencodeSessionId: input.sessionId,
      });
      try {
        const thread = await bb.sdk.threads.spawn({
          projectId: decision.projectId,
          providerId: PROVIDER_ID,
          prompt: input.prompt,
          model: input.model,
          environment: decision.environment as never,
        });
        await bb.storage.kv.delete(
          pendingAdoptStorageKey({
            projectId: input.projectId,
            hostId,
            opencodeSessionId: input.sessionId,
          }),
        );
        return { threadId: thread.id };
      } catch (error) {
        consumeNextAdopt(nextAdopts, {
          projectId: decision.projectId,
          isNewThread: true,
        });
        throw error;
      }
    },
    async summarize({ threadId }) {
      try {
        const thread = fullThreadFields(await bb.sdk.threads.get({ threadId }));
        if (thread.providerId !== PROVIDER_ID) {
          return { ok: false, error: null };
        }
        const hostId = await resolveHostId(bb, thread.environmentId);
        const sessionId = await resolveSessionId(
          bb,
          threadId,
          thread.providerThreadId,
        );
        if (!hostId || !sessionId) {
          return { ok: false, error: "Thread is not bound to an OpenCode session" };
        }
        return host.call(
          "summarize",
          {
            sessionId,
            ...(thread.model ? { model: thread.model } : {}),
          },
          { hostId },
        );
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async listTaskChildren({ threadId }) {
      return listTaskChildren(bb, host, threadId);
    },
    async openTaskChild(input) {
      return openTaskChildThread(bb, host, input);
    },
    async listCommands({ directory }) {
      const hostId = await firstHostId(bb);
      if (!hostId) return { commands: [] };
      return host.call("listCommands", { directory }, { hostId });
    },
    async undo({ threadId, messageID, role, text }) {
      return revertThread(bb, host, threadId, "revert", {
        messageID,
        role,
        text,
      });
    },
    async redo({ threadId }) {
      return revertThread(bb, host, threadId, "unrevert");
    },
    async forkFromMessage({ threadId, sourceSeqEnd }) {
      try {
        const thread = threadFields(await bb.sdk.threads.get({ threadId }));
        if (thread.providerId !== PROVIDER_ID) {
          return { threadId: null, projectId: null, error: null };
        }
        const created = await bb.sdk.threads.fork({
          sourceThreadId: threadId,
          sourceSeqEnd,
          workspace: "reuse",
        });
        return {
          threadId: created.id,
          projectId: created.projectId,
          error: null,
        };
      } catch (error) {
        return {
          threadId: null,
          projectId: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  bb.ui.registerMentionProvider({
    id: "opencode-subagent",
    label: "OpenCode agents",
    triggers: ["@"],
    async search({ query, threadId, projectId }) {
      try {
        if (threadId) {
          const thread = threadFields(await bb.sdk.threads.get({ threadId }));
          if (thread.providerId !== PROVIDER_ID) {
            bb.log.info(
              `mention skip thread=${threadId} provider=${thread.providerId ?? "none"}`,
            );
            return [];
          }
        }
        const hostId = await firstHostId(bb);
        const agents = hostId
          ? await loadAgents(host, hostId).catch((error) => {
              bb.log.warn(`mention loadAgents failed: ${String(error)}`);
              return fallbackSelectableAgents();
            })
          : fallbackSelectableAgents();
        if (!hostId) {
          bb.log.warn("mention: no enrolled host; using fallback agents");
        }
        const items = listAgentMentions(agents, query);
        bb.log.info(
          `mention q=${JSON.stringify(query)} thread=${threadId ?? "new"} project=${projectId ?? "none"} agents=${agents.length} hits=${items.length}`,
        );
        return items;
      } catch (error) {
        bb.log.warn(`mention search failed: ${String(error)}`);
        return listAgentMentions(fallbackSelectableAgents(), query);
      }
    },
    resolve(itemId) {
      return mentionResolveContext(itemId);
    },
  });

  setTimeout(() => {
    void (async () => {
      const hostId = await firstHostId(bb);
      if (!hostId) {
        bb.status.needsConfiguration("No enrolled host for OpenCode.");
        return;
      }
      const probe = await host.call("probe", {}, { hostId });
      if (probe.needsConfiguration) {
        bb.status.needsConfiguration(
          probe.error ??
            "OpenCode binary missing or version outside the pinned window.",
        );
      }
    })().catch((error) => {
      bb.log.warn(`OpenCode probe failed: ${String(error)}`);
    });
  }, 0);

  let taskPollInFlight = false;
  const pollTaskChildren = () => {
    if (taskPollInFlight) return;
    taskPollInFlight = true;
    void ensureRunningTaskChildThreads(bb, host)
      .catch((error) => {
        bb.log.warn(`OpenCode task-child bind failed: ${String(error)}`);
      })
      .finally(() => {
        taskPollInFlight = false;
      });
  };
  for (const previous of taskPollTimers) clearInterval(previous);
  taskPollTimers.clear();
  const timer = setInterval(pollTaskChildren, 1500);
  taskPollTimers.add(timer);
  bb.onDispose(() => {
    clearInterval(timer);
    taskPollTimers.delete(timer);
  });

  bb.cli.register({
    name: "opencode",
    summary: "OpenCode operator surface",
    commands: [
      {
        name: "status",
        summary: "Show binary, version, attach state, port, range",
        usage: "bb opencode status",
      },
      {
        name: "version",
        summary: "Print SDK pin and attached server version",
        usage: "bb opencode version",
      },
      {
        name: "logs",
        summary: "Print recent plugin / OpenCode event tally lines",
        usage: "bb opencode logs",
      },
      {
        name: "commands",
        summary: "List OpenCode slash commands for a directory",
        usage: "bb opencode commands [directory]",
      },
    ],
    async run(argv) {
      const hostId = await firstHostId(bb);
      if (!hostId) {
        return { exitCode: 1, stderr: "No enrolled host\n" };
      }
      const command = argv[0] ?? "status";
      if (command === "status") {
        const probe = await host.call("probe", {}, { hostId });
        return {
          exitCode: probe.needsConfiguration ? 1 : 0,
          stdout:
            [
              `binary: ${probe.binaryPath ?? "missing"}`,
              `server: ${probe.serverVersion ?? "unknown"}`,
              `attached: ${probe.attached}`,
              `spawned: ${probe.spawned}`,
              `port: ${probe.port ?? "-"}`,
              `pid: ${probe.pid ?? "-"}`,
              `range: ${probe.supportedRange}`,
              `sdk: ${probe.sdkPin}`,
              probe.authError ? `auth: ${probe.authError}` : "",
              probe.error ? `error: ${probe.error}` : "",
              `serveCwd: ${probe.serveCwd ?? "-"}`,
              probe.configSummary ? `config: ${probe.configSummary}` : "",
              probe.serveLog.length > 0
                ? `serveLog:\n${probe.serveLog.join("\n")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n") + "\n",
        };
      }
      if (command === "version") {
        const probe = await host.call("probe", {}, { hostId });
        return {
          exitCode: 0,
          stdout: `sdk ${probe.sdkPin}\nserver ${probe.serverVersion ?? "unattached"}\n`,
        };
      }
      if (command === "logs") {
        const logs = await host.call("logs", { limit: 80 }, { hostId });
        return { exitCode: 0, stdout: `${logs.lines.join("\n")}\n` };
      }
      if (command === "commands") {
        const directory = argv[1];
        const listed = await host.call(
          "listCommands",
          directory ? { directory } : {},
          { hostId },
        );
        return {
          exitCode: 0,
          stdout:
            listed.commands
              .map((item) =>
                item.description
                  ? `/${item.name}  ${item.description}`
                  : `/${item.name}`,
              )
              .join("\n") + "\n",
        };
      }
      return { exitCode: 1, stderr: `Unknown command ${command}\n` };
    },
  });

}

const TITLE_PERSIST_MS = process.env.VITEST ? [0, 1] : [0, 1500, 4000, 8000];

function schedulePublishedTitlePersist(
  bb: BbPluginApi,
  thread: { id: string; providerId?: string | null; title?: string | null },
): void {
  if (thread.providerId !== PROVIDER_ID || thread.title) return;
  void (async () => {
    for (const delay of TITLE_PERSIST_MS) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        const latest = await bb.sdk.threads.get({ threadId: thread.id });
        const applied = await persistPublishedOpenCodeTitle({
          providerId: latest.providerId ?? null,
          title: latest.title ?? null,
          listEvents: () =>
            bb.sdk.threads.events.list({
              threadId: thread.id,
              types: ["thread/name/updated"],
              order: "desc",
              limit: "20",
            }),
          updateTitle: async (title) => {
            await bb.sdk.threads.update({ threadId: thread.id, title });
          },
        });
        if (applied || latest.title) return;
      } catch {
        return;
      }
    }
  })();
}

async function firstHostId(bb: BbPluginApi): Promise<string | undefined> {
  const hosts = await bb.sdk.hosts.list();
  return hosts[0]?.id;
}

async function resolveSessionId(
  bb: BbPluginApi,
  threadId: string,
  fallback: string | null,
): Promise<string | null> {
  if (fallback) return fallback;
  try {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      types: ["thread/identity"],
      order: "desc",
      limit: "20",
    });
    return sessionIdFromThreadEvents(rows);
  } catch {
    return null;
  }
}

function threadFields(thread: unknown): {
  providerId: string | null;
  providerThreadId: string | null;
  environmentId: string | null;
} {
  const record = fullThreadFields(thread);
  return {
    providerId: record.providerId,
    providerThreadId: record.providerThreadId,
    environmentId: record.environmentId,
  };
}

function fullThreadFields(thread: unknown): {
  id: string | null;
  projectId: string | null;
  parentThreadId: string | null;
  providerId: string | null;
  providerThreadId: string | null;
  environmentId: string | null;
  model: string | null;
  status: string | null;
} {
  const record = thread as {
    id?: string | null;
    projectId?: string | null;
    parentThreadId?: string | null;
    providerId?: string | null;
    providerThreadId?: string | null;
    environmentId?: string | null;
    model?: string | null;
    status?: string | null;
  };
  return {
    id: record.id ?? null,
    projectId: record.projectId ?? null,
    parentThreadId: record.parentThreadId ?? null,
    providerId: record.providerId ?? null,
    providerThreadId: record.providerThreadId ?? null,
    environmentId: record.environmentId ?? null,
    model: record.model ?? null,
    status: record.status ?? null,
  };
}

type ListedSessions = {
  sessions: Array<{
    id: string;
    title: string | null;
    directory: string | null;
    parentID: string | null;
    running: boolean;
  }>;
};

type SessionSnapshot = {
  title: string | null;
  directory: string | null;
  parentID: string | null;
};

const spawningTaskChildren = new Set<string>();
const skippedTaskChildrenUntil = new Map<string, number>();

async function listProjectThreads(bb: BbPluginApi) {
  return bb.sdk.threads.list({
    includeHidden: true,
    limit: 200,
  });
}

function importedSessionIds(threads: unknown[]): Set<string> {
  return new Set(
    threads
      .map((thread) => fullThreadFields(thread))
      .filter(
        (thread) =>
          thread.providerId === PROVIDER_ID && thread.providerThreadId,
      )
      .map((thread) => thread.providerThreadId as string),
  );
}

async function spawnBoundTaskChild(
  bb: BbPluginApi,
  args: {
    projectId: string;
    hostId: string;
    parentThreadId: string;
    environmentId: string | null;
    sessionId: string;
    title: string | null;
    bindOnly: boolean;
    prompt?: string;
  },
) {
  armNextAdopt(nextAdopts, {
    projectId: args.projectId,
    hostId: args.hostId,
    opencodeSessionId: args.sessionId,
    bindOnly: args.bindOnly,
  });
  try {
    const thread = await bb.sdk.threads.spawn({
      projectId: args.projectId,
      providerId: PROVIDER_ID,
      parentThreadId: args.parentThreadId,
      title: taskChildThreadTitle(args.title),
      ...(args.prompt
        ? { prompt: args.prompt }
        : { input: taskChildBindInput() }),
      environment: args.environmentId
        ? { type: "reuse", environmentId: args.environmentId }
        : { type: "project-default" },
    });
    return thread.id;
  } catch (error) {
    disarmNextAdopt(nextAdopts, {
      projectId: args.projectId,
      opencodeSessionId: args.sessionId,
    });
    throw error;
  }
}

async function ensureRunningTaskChildThreads(
  bb: BbPluginApi,
  host: ReturnType<BbPluginApi["hosts"]["experimental_client"]>,
): Promise<void> {
  const hostId = await firstHostId(bb);
  if (!hostId) return;
  const listed = (await host.call("listSessions", {}, { hostId })) as ListedSessions;
  const threads = await listProjectThreads(bb);
  const imported = importedSessionIds(threads);
  const bySession = new Map<string, ReturnType<typeof fullThreadFields>>();
  for (const thread of threads) {
    const fields = fullThreadFields(thread);
    if (fields.providerId === PROVIDER_ID && fields.providerThreadId) {
      bySession.set(fields.providerThreadId, fields);
    }
  }
  for (const session of listed.sessions) {
    if (!session.parentID) continue;
    const parent = bySession.get(session.parentID);
    if (
      !shouldAutoBindTaskChild({
        parentBound: Boolean(parent?.id && parent.projectId),
        alreadyImported: imported.has(session.id),
        running: session.running,
      })
    ) {
      continue;
    }
    const now = Date.now();
    if ((skippedTaskChildrenUntil.get(session.id) ?? 0) > now) continue;
    if (spawningTaskChildren.has(session.id) || !parent?.id || !parent.projectId) {
      continue;
    }
    spawningTaskChildren.add(session.id);
    try {
      await spawnBoundTaskChild(bb, {
        projectId: parent.projectId,
        hostId,
        parentThreadId: parent.id,
        environmentId: parent.environmentId,
        sessionId: session.id,
        title: session.title,
        bindOnly: true,
      });
    } catch {
      skippedTaskChildrenUntil.set(session.id, now + 30_000);
    } finally {
      spawningTaskChildren.delete(session.id);
    }
  }
}

async function listTaskChildren(
  bb: BbPluginApi,
  host: ReturnType<BbPluginApi["hosts"]["experimental_client"]>,
  threadId: string,
) {
  const parent = fullThreadFields(await bb.sdk.threads.get({ threadId }));
  if (parent.providerId !== PROVIDER_ID) return { children: [] };
  const hostId = await resolveHostId(bb, parent.environmentId);
  const parentSessionId = await resolveSessionId(
    bb,
    threadId,
    parent.providerThreadId,
  );
  if (!hostId || !parentSessionId) return { children: [] };
  const listed = (await host.call("listSessions", {}, { hostId })) as ListedSessions;
  const threads = await listProjectThreads(bb);
  const threadBySession = new Map<string, string>();
  for (const thread of threads) {
    const fields = fullThreadFields(thread);
    if (fields.providerId === PROVIDER_ID && fields.providerThreadId && fields.id) {
      threadBySession.set(fields.providerThreadId, fields.id);
    }
  }
  return {
    children: listed.sessions
      .filter((session) => session.parentID === parentSessionId)
      .map((session) => {
        const childThreadId = threadBySession.get(session.id) ?? null;
        return {
          sessionId: session.id,
          title: taskChildThreadTitle(session.title),
          running: session.running,
          threadId: childThreadId,
          openable: Boolean(childThreadId) || !session.running,
        };
      }),
  };
}

async function openTaskChildThread(
  bb: BbPluginApi,
  host: ReturnType<BbPluginApi["hosts"]["experimental_client"]>,
  input: { projectId: string; parentThreadId: string; sessionId: string },
): Promise<{ threadId: string | null; created: boolean; error: string | null }> {
  try {
    const parent = fullThreadFields(
      await bb.sdk.threads.get({ threadId: input.parentThreadId }),
    );
    if (parent.providerId !== PROVIDER_ID) {
      return { threadId: null, created: false, error: "Not an OpenCode thread" };
    }
    const hostId = await resolveHostId(bb, parent.environmentId);
    if (!hostId) {
      return { threadId: null, created: false, error: "No enrolled host" };
    }
    const threads = await listProjectThreads(bb);
    const existing = threads
      .map((thread) => fullThreadFields(thread))
      .find(
        (thread) =>
          thread.providerId === PROVIDER_ID &&
          thread.providerThreadId === input.sessionId &&
          thread.id,
      );
    if (existing?.id) {
      return { threadId: existing.id, created: false, error: null };
    }
    const listed = (await host.call("listSessions", {}, { hostId })) as ListedSessions;
    const row = listed.sessions.find((session) => session.id === input.sessionId);
    if (!row) {
      return { threadId: null, created: false, error: "Unknown OpenCode session" };
    }
    if (row.running) {
      return {
        threadId: null,
        created: false,
        error: "Cannot open a running OpenCode session",
      };
    }
    const snapshot = (await host.call(
      "sessionSnapshot",
      { sessionId: input.sessionId },
      { hostId },
    )) as SessionSnapshot;
    const threadId = await spawnBoundTaskChild(bb, {
      projectId: input.projectId,
      hostId,
      parentThreadId: input.parentThreadId,
      environmentId: parent.environmentId,
      sessionId: input.sessionId,
      title: snapshot.title,
      bindOnly: true,
    });
    return { threadId, created: true, error: null };
  } catch (error) {
    return {
      threadId: null,
      created: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveHostId(
  bb: BbPluginApi,
  environmentId: string | null,
): Promise<string | undefined> {
  if (environmentId) {
    try {
      const environment = await bb.sdk.environments.get({
        environmentId,
      });
      if (environment.hostId) return environment.hostId;
    } catch {
      /* fall through */
    }
  }
  return firstHostId(bb);
}

async function loadComposerChrome(
  bb: BbPluginApi,
  host: ReturnType<BbPluginApi["hosts"]["experimental_client"]>,
  args: { threadId: string | null; projectId: string | null },
) {
  const hidden = {
    providerId: null as string | null,
    status: "hidden" as const,
    agent: "",
    options: [] as Array<{ name: string; description: string | null }>,
    error: null as string | null,
  };
  try {
    let threadProviderId: string | null = null;
    let environmentId: string | null = null;
    let lastUserAgent: string | undefined;
    if (args.threadId) {
      const thread = threadFields(await bb.sdk.threads.get({ threadId: args.threadId }));
      threadProviderId = thread.providerId;
      environmentId = thread.environmentId;
      const hostId = await resolveHostId(bb, environmentId);
      const sessionId = await resolveSessionId(
        bb,
        args.threadId,
        thread.providerThreadId,
      );
      if (hostId && sessionId) {
        const snapshot = (await host.call(
          "sessionSnapshot",
          { sessionId },
          { hostId },
        )) as { lastUserAgent: string | null };
        lastUserAgent = snapshot.lastUserAgent ?? undefined;
      }
    }
    let projectDefaultProviderId: string | null = null;
    if (!threadProviderId && args.projectId) {
      try {
        const defaults = await bb.sdk.projects.defaultExecutionOptions({
          projectId: args.projectId,
        });
        projectDefaultProviderId = defaults?.providerId ?? null;
      } catch {
        projectDefaultProviderId = null;
      }
    }
    const providerId = resolveComposerProvider({
      threadProviderId,
      projectDefaultProviderId,
      composeKind: args.threadId ? "thread" : "new-thread",
    });
    if (providerId !== PROVIDER_ID) {
      return { ...hidden, providerId };
    }
    const hostId = await resolveHostId(bb, environmentId);
    const listed = hostId
      ? await loadAgents(host, hostId).catch(() => fallbackSelectableAgents())
      : fallbackSelectableAgents();
    const agents =
      listSelectablePrimaries(listed).length > 0
        ? listed
        : fallbackSelectableAgents();
    const hydrated = hydratePickerAgent({ lastUserAgent, agents });
    const options = listSelectablePrimaries(agents).map((agent) => ({
      name: agent.name,
      description: agent.description ?? null,
    }));
    if (hydrated.status === "unknown") {
      return {
        providerId,
        status: "unknown" as const,
        agent: hydrated.agent,
        options,
        error: `Unknown OpenCode agent: ${hydrated.agent}. Pick a listed agent before sending.`,
      };
    }
    return {
      providerId,
      status: hydrated.status,
      agent: hydrated.agent,
      options,
      error: null,
    };
  } catch (error) {
    return {
      ...hidden,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function fallbackSelectableAgents(): OpenCodeAgent[] {
  return [
    { name: "build", mode: "primary", description: "Default OpenCode primary" },
    { name: "plan", mode: "primary", description: "Planning primary" },
    { name: "orchestrator", mode: "primary", description: "Orchestrator primary" },
  ];
}

async function loadAgents(
  host: ReturnType<BbPluginApi["hosts"]["experimental_client"]>,
  hostId: string,
): Promise<OpenCodeAgent[]> {
  const listed = (await host.call("listAgents", {}, { hostId })) as {
    agents: Array<{
      name: string;
      mode: string | null;
      hidden: boolean;
      description: string | null;
    }>;
  };
  return listed.agents.map((agent) => ({
    name: agent.name,
    mode: agent.mode ?? undefined,
    hidden: agent.hidden,
    description: agent.description ?? undefined,
  }));
}

async function decideImportTarget(
  bb: BbPluginApi,
  args: { hostId: string; currentProjectId: string; directory: string },
) {
  const listed = await bb.sdk.projects.list({ includePersonal: true });
  const projects: ImportProject[] = [];
  for (const project of listed) {
    const paths: string[] = [];
    const record = project as {
      id: string;
      kind?: string;
      personal?: boolean;
      path?: string;
      rootPath?: string;
      sources?: Array<{ path?: string }>;
    };
    if (typeof record.path === "string") paths.push(record.path);
    if (typeof record.rootPath === "string") paths.push(record.rootPath);
    for (const source of record.sources ?? []) {
      if (typeof source.path === "string") paths.push(source.path);
    }
    try {
      const full = await bb.sdk.projects.get({ projectId: project.id });
      const extra = full as {
        path?: string;
        sources?: Array<{ path?: string }>;
      };
      if (typeof extra.path === "string") paths.push(extra.path);
      for (const source of extra.sources ?? []) {
        if (typeof source.path === "string") paths.push(source.path);
      }
    } catch {
      /* list shape is enough */
    }
    projects.push({
      id: project.id,
      personal: record.personal === true || record.kind === "personal",
      paths,
    });
  }
  return resolveImportEnvironment({
    directory: args.directory,
    hostId: args.hostId,
    currentProjectId: args.currentProjectId,
    projects,
  });
}

async function revertThread(
  bb: BbPluginApi,
  host: ReturnType<BbPluginApi["hosts"]["experimental_client"]>,
  threadId: string,
  kind: "revert" | "unrevert",
  target?: { messageID?: string; role?: "user" | "assistant"; text?: string },
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const thread = threadFields(await bb.sdk.threads.get({ threadId }));
    if (thread.providerId !== PROVIDER_ID) {
      return { ok: false, error: null };
    }
    const hostId = await resolveHostId(bb, thread.environmentId);
    const sessionId = await resolveSessionId(
      bb,
      threadId,
      thread.providerThreadId,
    );
    if (!hostId || !sessionId) {
      return { ok: false, error: "Thread is not bound to an OpenCode session" };
    }
    if (kind === "revert") {
      const result = (await host.call(
        "revert",
        {
          sessionId,
          messageID: target?.messageID,
          role: target?.role,
          text: target?.text,
        },
        { hostId },
      )) as { ok: boolean; error: string | null };
      if (!result.ok) {
        return {
          ok: false,
          error: result.error ?? "Could not match that message",
        };
      }
    } else {
      const result = (await host.call("unrevert", { sessionId }, { hostId })) as {
        ok: boolean;
        error: string | null;
      };
      if (!result.ok) {
        return { ok: false, error: result.error ?? "nothing to redo" };
      }
    }
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
