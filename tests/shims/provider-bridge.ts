import { z } from "zod";

export const BRIDGE_REQUEST_METHODS = {
  initialize: "initialize",
  modelList: "model/list",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadStop: "thread/stop",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  skillsConfigure: "skills/configure",
} as const;

export const BRIDGE_NOTIFICATION_METHODS = {
  threadIdentity: "thread/identity",
} as const;

export const BRIDGE_INBOUND_REQUEST_METHODS = {
  interactionRequest: "interaction/request",
} as const;

export const BRIDGE_JSON_RPC_ERRORS = {
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  BRIDGE_ERROR: -32000,
  NO_ACTIVE_TURN: -32001,
} as const;

export const PROVIDER_BRIDGE_PROTOCOL_VERSION = 2;
export const THREAD_DELTA_GRAMMAR_V3 = 3;
export const THREAD_DELTA_NOTIFICATION_METHOD = "thread/delta";

export const initializeParamsSchema = z.object({}).passthrough();
export const modelListParamsSchema = z.object({}).passthrough();
export const threadStartParamsSchema = z
  .object({
    threadId: z.string(),
    cwd: z.string(),
    input: z.array(z.any()).optional(),
    options: z.any().optional(),
  })
  .passthrough();
export const threadResumeParamsSchema = z
  .object({
    threadId: z.string(),
    cwd: z.string(),
    providerThreadId: z.string(),
    options: z.any().optional(),
  })
  .passthrough();
export const threadStopParamsSchema = z
  .object({
    threadId: z.string(),
    providerThreadId: z.string(),
    intent: z.enum(["interrupt", "release"]),
  })
  .passthrough();
export const turnStartParamsSchema = z
  .object({
    threadId: z.string(),
    input: z.array(z.any()),
    clientRequestId: z.string().optional(),
    options: z.any().optional(),
  })
  .passthrough();
export const turnSteerParamsSchema = z
  .object({
    threadId: z.string(),
    expectedTurnId: z.string(),
    input: z.array(z.any()),
  })
  .passthrough();
export const skillsConfigureParamsSchema = z
  .object({
    roots: z.array(
      z
        .object({
          id: z.string().optional(),
          path: z.string().optional(),
          skills: z.array(z.any()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type PromptInput = {
  type: string;
  text?: string;
  path?: string;
  url?: string;
  name?: string;
  mimeType?: string;
  mentions?: unknown[];
};

export function experimental_defineProviderBridge(entry: {
  handleLine: (line: string) => void;
  start: (context: { dataDir: string; pluginId?: string; tempDir?: string }) => void;
}) {
  return entry;
}
