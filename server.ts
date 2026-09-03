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
  createNextAgentStore,
  peekNextAgent,
  resolveComposerProvider,
  resolvePromptAgent,
  UNBOUND_NEXT_AGENT_KEY,
} from "./src/next-agent.js";
import {
  pendingAdoptStorageKey,
  type PendingAdoptRecord,
} from "./src/pending-adopt.js";
import { classifyImportRow } from "./src/import-row.js";
import { listAgentMentions, mentionResolveContext } from "./src/mentions.js";
import {
  isPromptDerivedTitle,
  persistPublishedOpenCodeTitle,
} from "./src/session-title.js";
import { sessionIdFromThreadEvents } from "./src/session-bind.js";
import {
  EMPTY_REVERT_STATE,
  OPENCODE_REVERT_CHANNEL,
} from "./src/revert-state.js";
import {
  commitRevertProjection,
  EMPTY_REVERT_PROJECTION,
  hiddenRevertRowIds,
  rowIdsHiddenByRevert,
  stageRevertProjection,
  undoRevertProjection,
  type RevertProjectionState,
  type RevertTimelineRow,
} from "./src/revert-projection.js";
import {
  assignRunChips,
  collectChipTargets,
  flattenChipTargetPages,
  reasoningByTurnFromEvents,
  type RunChipMessage,
  type RunChipRow,
} from "./src/run-chip.js";
import {
  isThreadNotFoundError,
  taskChildBindInput,
  taskChildThreadTitle,
} from "./src/task-thread.js";
import {
  boundThreadForTaskChild,
  listLiveTaskChildren,
  rememberBoundTaskChild,
} from "./src/task-live.js";
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

  bb.providers.register({
    id: PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    icon: "./assets/icon.svg",
    maintenance: { health: true, usage: true, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: true,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["none", "low", "medium", "high"],
    },
    composerActions: [],
    experimental_visibility: "always",
    experimental_resolvesNativeRoots: true,
    strings: {
      signInHint: "Run `opencode auth` on this machine, then send again.",
      expiredHint: "OpenCode auth expired. Run `opencode auth` and send again.",
      installUrl: "https://opencode.ai/docs",
      brandPrefix: "OpenCode ",
    },
    env: { passthrough: ["OPENCODE_BIN"] },
    deriveProviderOptions(ctx) {
      const stamped = peekAgent(stamps, ctx.threadId);
      const next = stamped
        ? undefined
        : peekNextAgent(nextAgents, ctx.projectId);
      const agent = resolvePromptAgent({
        stamped,
        next,
        configured: configuredAgent,
      });
      bb.log.info(
        `agent.derive thread=${ctx.threadId} project=${ctx.projectId} stamped=${stamped ?? "-"} next=${next ?? "-"} agent=${agent}`,
      );
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
    async reload() {
      const hostId = await firstHostId(bb);
      if (!hostId) return { ok: false, error: "No enrolled host" };
      return host.call("reload", {}, { hostId });
    },
    async stampAgent(input) {
      const threadId = input.threadId?.trim() || undefined;
      const projectId = input.projectId?.trim() || undefined;
      if (threadId) {
        stampAgent(stamps, {
          threadId,
          agent: input.agent,
          queued: input.queued,
        });
      } else {
        armNextAgent(
          nextAgents,
          projectId ?? UNBOUND_NEXT_AGENT_KEY,
          input.agent,
        );
      }
      bb.log.info(
        `agent.stamp thread=${threadId ?? "-"} project=${projectId ?? "-"} agent=${input.agent} queued=${input.queued}`,
      );
      return { ok: true };
    },
    async stampPermissionMode(input) {
      try {
        const thread = threadFields(
          await bb.sdk.threads.get({ threadId: input.threadId }),
        );
        if (thread.providerId !== PROVIDER_ID) return { ok: true };
        const hostId = await resolveHostId(bb, thread.environmentId);
        if (!hostId) return { ok: false };
        await host.call("stampPermissionMode", input, { hostId });
        return { ok: true };
      } catch {
        return { ok: false };
      }
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
          model: snapshot.model,
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
    async messageRunChips({ threadIds }) {
      return { rows: await loadMessageRunChips(bb, host, threadIds) };
    },
    async undo({ threadId, messageID, messageId, role, text }) {
      return revertThread(bb, host, threadId, "revert", {
        messageID,
        bbMessageId: messageId,
        role,
        text,
      });
    },
    async redo({ threadId }) {
      return revertThread(bb, host, threadId, "unrevert");
    },
    async revertState({ threadId }) {
      try {
        const thread = threadFields(await bb.sdk.threads.get({ threadId }));
        if (thread.providerId !== PROVIDER_ID) {
          return {
            ...EMPTY_REVERT_STATE,
            error: null,
            hiddenRowIds: [],
          };
        }
        const hostId = await resolveHostId(bb, thread.environmentId);
        const sessionId = await resolveSessionId(
          bb,
          threadId,
          thread.providerThreadId,
        );
        if (!hostId || !sessionId) {
          return {
            ...EMPTY_REVERT_STATE,
            error: "Thread is not bound to an OpenCode session",
            hiddenRowIds: [],
          };
        }
        const state = await host.call(
          "revertState",
          { sessionId },
          { hostId },
        );
        let projection = await readRevertProjection(bb, threadId);
        if (!state.active && projection.stagedRowIds.length > 0) {
          projection = commitRevertProjection(projection);
          await writeRevertProjection(bb, threadId, projection);
        }
        return {
          ...state,
          error: null,
          hiddenRowIds: hiddenRevertRowIds(projection),
        };
      } catch (error) {
        const projection = await readRevertProjection(bb, threadId).catch(
          () => EMPTY_REVERT_PROJECTION,
        );
        return {
          ...EMPTY_REVERT_STATE,
          error: error instanceof Error ? error.message : String(error),
          hiddenRowIds: hiddenRevertRowIds(projection),
        };
      }
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
  let taskPollDisposed = false;
  let timer: ReturnType<typeof setInterval>;
  const stopTaskPoll = () => {
    taskPollDisposed = true;
    clearInterval(timer);
    taskPollTimers.delete(timer);
  };
  const pollTaskChildren = () => {
    if (taskPollDisposed || taskPollInFlight) return;
    taskPollInFlight = true;
    void ensureRunningTaskChildThreads(bb, host)
      .catch((error) => {
        const message = String(error);
        if (message.includes("PluginContextStaleError")) {
          stopTaskPoll();
          return;
        }
        bb.log.warn(`OpenCode task-child bind failed: ${message}`);
      })
      .finally(() => {
        taskPollInFlight = false;
      });
  };
  for (const previous of taskPollTimers) clearInterval(previous);
  taskPollTimers.clear();
  timer = setInterval(pollTaskChildren, 750);
  taskPollTimers.add(timer);
  bb.onDispose(stopTaskPoll);

  bb.cli.register({
    name: "opencode",
    summary: "Check and manage the OpenCode server",
    commands: [
      {
        name: "status",
        summary: "Show whether OpenCode is running and how to reach it",
        usage: "bb opencode status",
      },
      {
        name: "version",
        summary: "Show which OpenCode version is connected",
        usage: "bb opencode version",
      },
      {
        name: "logs",
        summary: "Show recent OpenCode activity and errors",
        usage: "bb opencode logs",
      },
      {
        name: "commands",
        summary: "List the slash commands OpenCode offers",
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
  thread: {
    id: string;
    providerId?: string | null;
    title?: string | null;
    titleFallback?: string | null;
  },
): void {
  if (thread.providerId !== PROVIDER_ID) return;
  if (
    thread.title &&
    !isPromptDerivedTitle({
      title: thread.title,
      titleFallback: thread.titleFallback,
    })
  ) {
    return;
  }
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
          titleFallback: latest.titleFallback ?? null,
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
        if (applied) return;
        if (
          latest.title &&
          !isPromptDerivedTitle({
            title: latest.title,
            titleFallback: latest.titleFallback,
          })
        ) {
          return;
        }
      } catch {
        return;
      }
    }
  })();
}

const MAX_CHIP_TIMELINE_PAGES = 2;
const CHIP_CACHE_MS = 4000;
const chipCache = new Map<string, { at: number; rows: RunChipRow[] }>();

async function loadMessageRunChips(
  bb: BbPluginApi,
  host: ReturnType<BbPluginApi["hosts"]["experimental_client"]>,
  threadIds: readonly string[],
): Promise<RunChipRow[]> {
  const rows: RunChipRow[] = [];
  const now = Date.now();
  for (const threadId of threadIds) {
    const cached = chipCache.get(threadId);
    if (cached && now - cached.at < CHIP_CACHE_MS) {
      rows.push(...cached.rows);
      continue;
    }
    try {
      const thread = fullThreadFields(await bb.sdk.threads.get({ threadId }));
      if (thread.providerId !== PROVIDER_ID) {
        chipCache.set(threadId, { at: now, rows: [] });
        continue;
      }
      const hostId = await resolveHostId(bb, thread.environmentId);
      const sessionId = await resolveSessionId(
        bb,
        threadId,
        thread.providerThreadId,
      );
      if (!hostId || !sessionId) {
        chipCache.set(threadId, { at: now, rows: [] });
        continue;
      }

      const [targets, reasoningByTurn, listed] = await Promise.all([
        collectThreadChipTargets(bb, threadId),
        collectThreadReasoning(bb, threadId),
        host.call("listMessageMeta", { sessionId }, { hostId }) as Promise<{
          messages: RunChipMessage[];
        }>,
      ]);

      const painted = assignRunChips({
        targets,
        messages: listed.messages,
        reasoningByTurn,
      });
      chipCache.set(threadId, { at: now, rows: painted });
      rows.push(...painted);
    } catch {
      chipCache.set(threadId, { at: now, rows: [] });
    }
  }
  return rows;
}

async function collectThreadChipTargets(
  bb: BbPluginApi,
  threadId: string,
) {
  const pages = [];
  let beforeAnchorSeq: string | undefined;
  let beforeAnchorId: string | undefined;
  for (let page = 0; page < MAX_CHIP_TIMELINE_PAGES; page += 1) {
    const timeline = await bb.sdk.threads.timeline({
      threadId,
      includeNestedRows: "true",
      ...(beforeAnchorSeq && beforeAnchorId
        ? { beforeAnchorSeq, beforeAnchorId }
        : {}),
    });
    pages.push(collectChipTargets(timeline.rows));
    const older = timeline.timelinePage?.olderCursor;
    if (!timeline.timelinePage?.hasOlderRows || !older) break;
    beforeAnchorSeq = String(older.anchorSeq);
    beforeAnchorId = older.anchorId;
  }
  return flattenChipTargetPages(pages);
}

async function collectThreadReasoning(bb: BbPluginApi, threadId: string) {
  try {
    const events = await bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "asc",
      limit: "200",
    });
    return reasoningByTurnFromEvents(events);
  } catch {
    return new Map<string, string>();
  }
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
  model: string | null;
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
    model?: string | null;
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
      ...(args.model ? { model: args.model } : {}),
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
  const threads = await listProjectThreads(bb);
  const imported = importedSessionIds(threads);
  for (const live of listLiveTaskChildren().filter((row) => row.running)) {
    if (!live.parentThreadId) continue;
    if (
      imported.has(live.childSessionId) ||
      spawningTaskChildren.has(live.childSessionId) ||
      boundThreadForTaskChild(live.childSessionId) ||
      live.boundThreadId
    ) {
      continue;
    }
    const now = Date.now();
    if ((skippedTaskChildrenUntil.get(live.childSessionId) ?? 0) > now) continue;
    const listedParent = threads
      .map((thread) => fullThreadFields(thread))
      .find((thread) => thread.id === live.parentThreadId);
    let parent = listedParent;
    if (!parent) {
      try {
        parent = fullThreadFields(
          await bb.sdk.threads.get({ threadId: live.parentThreadId }),
        );
      } catch (error) {
        skippedTaskChildrenUntil.set(
          live.childSessionId,
          now + (isThreadNotFoundError(error) ? 300_000 : 30_000),
        );
        if (!isThreadNotFoundError(error)) {
          bb.log.warn(
            `OpenCode Task parent lookup failed ${live.parentThreadId}: ${String(error)}`,
          );
        }
        continue;
      }
    }
    if (parent.providerId !== PROVIDER_ID || !parent.id || !parent.projectId) continue;
    spawningTaskChildren.add(live.childSessionId);
    try {
      const snapshot = (await host.call(
        "sessionSnapshot",
        { sessionId: live.childSessionId },
        { hostId },
      )) as SessionSnapshot;
      const childThreadId = await spawnBoundTaskChild(bb, {
        projectId: parent.projectId,
        hostId,
        parentThreadId: parent.id,
        environmentId: parent.environmentId,
        sessionId: live.childSessionId,
        title: live.title,
        bindOnly: true,
        model: snapshot.model,
      });
      rememberBoundTaskChild(live.childSessionId, childThreadId);
      bb.log.info(
        `OpenCode bound Task child ${live.childSessionId} -> ${childThreadId} parent=${parent.id}`,
      );
    } catch (error) {
      skippedTaskChildrenUntil.set(live.childSessionId, now + 30_000);
      bb.log.warn(
        `OpenCode Task child bind failed ${live.childSessionId}: ${String(error)}`,
      );
    } finally {
      spawningTaskChildren.delete(live.childSessionId);
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
      model: snapshot.model,
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

const REVERT_THREAD_SETTLE_TIMEOUT_MS = 15_000;
const REVERT_THREAD_SETTLE_POLL_MS = 100;
const REVERT_PROJECTION_KEY_PREFIX = "revert-projection:";

function revertProjectionKey(threadId: string): string {
  return `${REVERT_PROJECTION_KEY_PREFIX}${threadId}`;
}

async function readRevertProjection(
  bb: BbPluginApi,
  threadId: string,
): Promise<RevertProjectionState> {
  const stored = await bb.storage.kv.get<Partial<RevertProjectionState>>(
    revertProjectionKey(threadId),
  );
  return {
    committedRowIds: Array.isArray(stored?.committedRowIds)
      ? stored.committedRowIds.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [],
    stagedRowIds: Array.isArray(stored?.stagedRowIds)
      ? stored.stagedRowIds.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [],
  };
}

async function writeRevertProjection(
  bb: BbPluginApi,
  threadId: string,
  state: RevertProjectionState,
): Promise<void> {
  if (hiddenRevertRowIds(state).length === 0) {
    await bb.storage.kv.delete(revertProjectionKey(threadId));
    return;
  }
  await bb.storage.kv.set(revertProjectionKey(threadId), state);
}

async function timelineRowsHiddenFromMessage(
  bb: BbPluginApi,
  threadId: string,
  messageId: string | undefined,
): Promise<string[]> {
  if (!messageId) return [];
  const timeline = (await bb.sdk.threads.timeline({ threadId })) as {
    rows?: RevertTimelineRow[];
  };
  return rowIdsHiddenByRevert(timeline.rows ?? [], messageId);
}

async function waitForThreadRevertQuiescence(
  bb: BbPluginApi,
  threadId: string,
): Promise<void> {
  let thread = fullThreadFields(await bb.sdk.threads.get({ threadId }));
  if (thread.status !== "idle" && thread.status !== "error") {
    // OpenCode abort settles the provider first. BB stop then closes any
    // pending interaction/turn and releases the bridge without fabricating a
    // replacement prompt; the next send resumes this same provider session.
    await bb.sdk.threads.stop({ threadId });
  }
  const deadline = Date.now() + REVERT_THREAD_SETTLE_TIMEOUT_MS;
  while (true) {
    thread = fullThreadFields(await bb.sdk.threads.get({ threadId }));
    if (thread.status === "idle" || thread.status === "error") return;
    if (Date.now() >= deadline) {
      throw new Error("BB thread did not settle before revert");
    }
    await new Promise((resolve) =>
      setTimeout(resolve, REVERT_THREAD_SETTLE_POLL_MS),
    );
  }
}

async function revertThread(
  bb: BbPluginApi,
  host: ReturnType<BbPluginApi["hosts"]["experimental_client"]>,
  threadId: string,
  kind: "revert" | "unrevert",
  target?: {
    messageID?: string;
    bbMessageId?: string;
    role?: "user" | "assistant";
    text?: string;
  },
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
    const settled = (await host.call(
      "settleSession",
      { sessionId },
      { hostId },
    )) as { ok: boolean; error: string | null };
    if (!settled.ok) {
      return {
        ok: false,
        error: settled.error ?? "OpenCode session did not settle",
      };
    }
    await waitForThreadRevertQuiescence(bb, threadId);
    const hiddenByThisRevert =
      kind === "revert"
        ? await timelineRowsHiddenFromMessage(bb, threadId, target?.bbMessageId)
        : [];
    if (
      kind === "revert" &&
      target?.bbMessageId &&
      hiddenByThisRevert.length === 0
    ) {
      return { ok: false, error: "Could not locate that BB message" };
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
      const result = (await host.call(
        "unrevert",
        { sessionId },
        { hostId },
      )) as { ok: boolean; error: string | null };
      if (!result.ok) {
        return { ok: false, error: result.error ?? "nothing to redo" };
      }
    }

    const projection = await readRevertProjection(bb, threadId);
    await writeRevertProjection(
      bb,
      threadId,
      kind === "revert"
        ? stageRevertProjection(projection, hiddenByThisRevert)
        : undoRevertProjection(projection),
    );
    bb.realtime.publish(OPENCODE_REVERT_CHANNEL, { threadId });
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
