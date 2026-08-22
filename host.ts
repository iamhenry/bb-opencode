import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import {
  handleListAgents,
  handleListCommands,
  handleListSessions,
  handleLogs,
  handleProbe,
  handleRevert,
  handleSessionSnapshot,
  handleUnrevert,
} from "./src/host-handlers.js";

export { experimental_providerBridge } from "./src/bridge.js";

export default experimental_defineHostEntry({
  contract: hostContract,
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
      };
    },
    async logs(input) {
      return handleLogs(input.limit);
    },
    async listSessions(_input, context) {
      return handleListSessions(context.experimental_paths.dataDir);
    },
    async sessionSnapshot(input, context) {
      return handleSessionSnapshot(
        context.experimental_paths.dataDir,
        input.sessionId,
      );
    },
    async revert(input, context) {
      return handleRevert(
        context.experimental_paths.dataDir,
        input.sessionId,
        input.messageID,
      );
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
  },
});
