import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_filterResolvedNativeRoots,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { PROVIDER_ID } from "./src/identity.js";
import { opencodeNativeRoots } from "./src/native-roots.js";
import {
  handleListAgents,
  handleListCommands,
  handleListMessageMeta,
  handleListSessions,
  handleLogs,
  handleProbe,
  handleRevert,
  handleSessionSnapshot,
  handleStampPermissionMode,
  handleSummarize,
  handleUnrevert,
} from "./src/host-handlers.js";

export { experimental_providerBridge } from "./src/bridge.js";

export default experimental_defineHostEntry({
  contract: { ...hostContract, ...experimental_nativeRootsHostContract },
  handlers: {
    async probe(_input, context) {
      const result = await handleProbe(context.experimental_paths.dataDir);
      return {
        binaryPath: result.binaryPath ?? null,
        serverVersion: result.serverVersion ?? null,
        attached: result.attached,
        spawned: result.spawned,
        port: result.port ?? null,
        pid: result.pid ?? null,
        supportedRange: result.supportedRange,
        sdkPin: result.sdkPin,
        authError: result.authError ?? null,
        error: result.error ?? null,
        needsConfiguration: result.needsConfiguration,
        serveCwd: result.serveCwd ?? null,
        configSummary: result.configSummary ?? null,
        serveLog: result.serveLog ?? [],
      };
    },
    async logs(input) {
      return handleLogs(input.limit);
    },
    async listSessions(input, context) {
      return handleListSessions(
        context.experimental_paths.dataDir,
        input.parentSessionId,
      );
    },
    async sessionSnapshot(input, context) {
      return handleSessionSnapshot(
        context.experimental_paths.dataDir,
        input.sessionId,
      );
    },
    async revert(input, context) {
      return handleRevert(context.experimental_paths.dataDir, input.sessionId, {
        messageID: input.messageID,
        role: input.role,
        text: input.text,
      });
    },
    async unrevert(input, context) {
      return handleUnrevert(context.experimental_paths.dataDir, input.sessionId);
    },
    async listAgents(_input, context) {
      return handleListAgents(context.experimental_paths.dataDir);
    },
    async listCommands(input, context) {
      return handleListCommands(
        context.experimental_paths.dataDir,
        input.directory,
      );
    },
    async summarize(input, context) {
      return handleSummarize(
        context.experimental_paths.dataDir,
        input.sessionId,
        input.model,
      );
    },
    async listMessageMeta(input, context) {
      return handleListMessageMeta(
        context.experimental_paths.dataDir,
        input.sessionId,
      );
    },
    async stampPermissionMode(input, context) {
      return handleStampPermissionMode(
        context.experimental_paths.dataDir,
        input.threadId,
        input.permissionMode,
      );
    },
    async resolveNativeRoots(input) {
      if (input.providerId !== PROVIDER_ID) {
        return { skills: [], commands: [] };
      }
      const { answer } = experimental_filterResolvedNativeRoots(
        opencodeNativeRoots({
          cwd: input.cwd,
          homeDir: homedir(),
        }),
        { warn: (message) => console.warn(message) },
      );
      return answer;
    },
  },
});
