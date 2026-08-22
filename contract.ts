import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const probeOutput = z
  .object({
    binaryPath: z.string().nullable(),
    serverVersion: z.string().nullable(),
    attached: z.boolean(),
    spawned: z.boolean(),
    port: z.number().nullable(),
    pid: z.number().nullable(),
    supportedRange: z.string(),
    sdkPin: z.string(),
    authError: z.string().nullable(),
    error: z.string().nullable(),
    needsConfiguration: z.boolean(),
  })
  .strict();

export const hostContract = defineRpcContract({
  probe: {
    input: z.object({}).strict(),
    output: probeOutput,
  },
  logs: {
    input: z.object({ limit: z.number().int().positive().max(200).optional() }).strict(),
    output: z.object({ lines: z.array(z.string()) }).strict(),
  },
  listSessions: {
    input: z.object({}).strict(),
    output: z.object({
      sessions: z.array(
        z
          .object({
            id: z.string(),
            title: z.string().nullable(),
            directory: z.string().nullable(),
            parentID: z.string().nullable(),
            running: z.boolean(),
          })
          .strict(),
      ),
    }).strict(),
  },
  sessionSnapshot: {
    input: z.object({ sessionId: z.string().min(1) }).strict(),
    output: z
      .object({
        id: z.string(),
        title: z.string().nullable(),
        directory: z.string().nullable(),
        parentID: z.string().nullable(),
        lastUserAgent: z.string().nullable(),
      })
      .strict(),
  },
  revert: {
    input: z
      .object({
        sessionId: z.string().min(1),
        messageID: z.string().min(1).optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  unrevert: {
    input: z.object({ sessionId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  listCommands: {
    input: z
      .object({
        directory: z.string().min(1).optional(),
      })
      .strict(),
    output: z
      .object({
        commands: z.array(
          z
            .object({
              name: z.string(),
              description: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  listAgents: {
    input: z.object({}).strict(),
    output: z
      .object({
        agents: z.array(
          z
            .object({
              name: z.string(),
              mode: z.string().nullable(),
              hidden: z.boolean(),
              description: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
});

export const rpcContract = defineRpcContract({
  threadProvider: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ providerId: z.string().nullable() }).strict(),
  },
  probe: {
    input: z.null(),
    output: probeOutput,
  },
  stampAgent: {
    input: z
      .object({
        threadId: z.string().min(1).optional(),
        projectId: z.string().min(1).optional(),
        agent: z.string().min(1),
        queued: z.boolean(),
      })
      .strict()
      .refine((value) => Boolean(value.threadId || value.projectId), {
        message: "threadId or projectId is required",
      }),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  composerChrome: {
    input: z
      .object({
        threadId: z.string().min(1).nullable(),
        projectId: z.string().min(1).nullable(),
      })
      .strict(),
    output: z
      .object({
        providerId: z.string().nullable(),
        status: z.enum(["selected", "default", "unknown", "hidden"]),
        agent: z.string(),
        options: z.array(
          z.object({ name: z.string(), description: z.string().nullable() }),
        ),
        error: z.string().nullable(),
      })
      .strict(),
  },
  hydratePicker: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        status: z.enum(["selected", "default", "unknown", "hidden"]),
        agent: z.string(),
        options: z.array(z.object({ name: z.string(), description: z.string().nullable() })),
        error: z.string().nullable(),
      })
      .strict(),
  },
  listImport: {
    input: z.null(),
    output: z
      .object({
        hostId: z.string().nullable(),
        sessions: z.array(
          z
            .object({
              id: z.string(),
              title: z.string().nullable(),
              directory: z.string().nullable(),
              parentID: z.string().nullable(),
              blocked: z.boolean(),
              blockReason: z.string().nullable(),
              alreadyImported: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  confirmImport: {
    input: z
      .object({
        projectId: z.string().min(1),
        hostId: z.string().min(1),
        sessionIds: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    output: z.object({ written: z.number().int() }).strict(),
  },
  openImported: {
    input: z
      .object({
        projectId: z.string().min(1),
        hostId: z.string().min(1),
        sessionId: z.string().min(1),
        prompt: z.string().min(1),
        environment: z.unknown(),
        model: z.string().optional(),
      })
      .strict(),
    output: z.object({ threadId: z.string() }).strict(),
  },
  undo: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }).strict(),
  },
  redo: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }).strict(),
  },
  listCommands: {
    input: z
      .object({
        directory: z.string().min(1).optional(),
      })
      .strict(),
    output: z
      .object({
        commands: z.array(
          z
            .object({
              name: z.string(),
              description: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
});
