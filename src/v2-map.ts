/**
 * OpenCode V2 → V1-shaped events and messages.
 *
 * The bridge was built on V1 part snapshots (`message.part.updated`) and the
 * 1.18 `session.next.*` text stream. V2 only emits the new session event
 * stream, so this module translates it at the client boundary and the bridge
 * keeps its proven mapping logic.
 */

export type V1Event = { type: string; properties?: unknown };

type Rec = Record<string, unknown>;

const rec = (value: unknown): Rec =>
  value && typeof value === "object" ? (value as Rec) : {};
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** V2 tool names the bridge knows under their V1 name. */
export function v1ToolName(name: string): string {
  if (name === "subagent") return "task";
  return name;
}

function v1ToolInput(name: string, input: Rec): Rec {
  if (name === "subagent" && typeof input.agent === "string") {
    return { ...input, subagent_type: input.agent };
  }
  return input;
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      const r = rec(item);
      return r.type === "text" && typeof r.text === "string" ? r.text : "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}

function errorText(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  const r = rec(error);
  return str(r.message) ?? str(rec(r.data).message) ?? str(r.type);
}

/** V2 `SessionError` → V1 `{ name, data: { message } }` read by describeSessionError. */
export function v1Error(error: unknown): Rec {
  const r = rec(error);
  const message = errorText(error) ?? "OpenCode session error";
  const type = str(r.type) ?? str(r.name) ?? "UnknownError";
  const name =
    type === "provider-auth" || type === "ProviderAuthError"
      ? "ProviderAuthError"
      : type === "output-length" || type === "MessageOutputLengthError"
        ? "MessageOutputLengthError"
        : type;
  return {
    name,
    message,
    data: { message, ...(str(r.providerID) ? { providerID: r.providerID } : {}) },
  };
}

interface ToolState {
  name: string;
  input: Rec;
  metadata: Rec;
  messageID?: string;
}

export interface V2EventState {
  tools: Map<string, ToolState>;
  steps: Map<string, Rec>;
}

export function createV2EventState(): V2EventState {
  return { tools: new Map(), steps: new Map() };
}

function toolPart(args: {
  sessionID: string;
  messageID?: string;
  id: string;
  tool: ToolState;
  status: "pending" | "running" | "completed" | "error";
  output?: string;
  error?: string;
}): Rec {
  const background = args.tool.name === "subagent" && args.tool.input.background === true;
  const metadata = background ? { ...args.tool.metadata, background: true } : args.tool.metadata;
  return {
    id: args.id,
    callID: args.id,
    type: "tool",
    tool: v1ToolName(args.tool.name),
    sessionID: args.sessionID,
    ...(args.messageID ? { messageID: args.messageID } : {}),
    state: {
      status: args.status,
      input: v1ToolInput(args.tool.name, args.tool.input),
      metadata,
      ...(str(metadata.title) ? { title: metadata.title } : {}),
      ...(args.output !== undefined ? { output: args.output } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    },
  };
}

function partEvent(sessionID: string, part: Rec): V1Event {
  return { type: "message.part.updated", properties: { sessionID, part } };
}

/** V2 permission request → V1 ask fields the permission mapper reads. */
export function v1PermissionAsk(request: unknown): Rec {
  const r = rec(request);
  const source = rec(r.source);
  return {
    ...r,
    permission: r.action,
    patterns: Array.isArray(r.resources) ? r.resources : [],
    ...(str(source.id)
      ? { tool: { messageID: source.messageID, callID: source.id } }
      : {}),
  };
}

/** V2 question form → V1 `question.asked` payload. Non-question forms return undefined. */
export function v1QuestionAsk(form: unknown): Rec | undefined {
  const f = rec(form);
  const metadata = rec(f.metadata);
  if (metadata.kind !== "question") return undefined;
  const fields = Array.isArray(f.fields) ? f.fields.map(rec) : [];
  const tool = rec(metadata.tool);
  return {
    id: f.id,
    sessionID: f.sessionID,
    questions: fields.map((field) => ({
      question: str(field.description) ?? str(field.title) ?? "",
      header: field.title,
      multiple: field.type === "multiselect",
      custom: field.custom !== false,
      options: (Array.isArray(field.options) ? field.options : []).map((o) => {
        const opt = rec(o);
        return { label: str(opt.label) ?? str(opt.value) ?? "", description: opt.description };
      }),
    })),
    ...(str(tool.id) ? { tool: { messageID: tool.messageID, callID: tool.id } } : {}),
    _fields: fields.map((field) => ({ key: field.key, type: field.type })),
  };
}

function modelFields(model: unknown): Rec {
  const m = rec(model);
  return {
    ...(str(m.id) ? { modelID: m.id } : {}),
    ...(str(m.providerID) ? { providerID: m.providerID } : {}),
    ...(str(m.variant) && m.variant !== "default" ? { variant: m.variant } : {}),
  };
}

/** Translate one V2 event into zero or more V1-shaped events. */
export function translateV2Event(state: V2EventState, event: unknown): V1Event[] {
  const e = rec(event);
  const type = str(e.type);
  if (!type) return [];
  const d = rec(e.data);
  const sessionID = str(d.sessionID);
  const mid = str(d.assistantMessageID);

  switch (type) {
    case "session.text.delta":
      if (!sessionID || !mid) return [];
      return [
        {
          type: "session.next.text.delta",
          properties: { sessionID, textID: `${mid}:t${d.ordinal ?? 0}`, delta: d.delta },
        },
      ];
    case "session.text.ended":
      if (!sessionID || !mid) return [];
      return [
        {
          type: "session.next.text.ended",
          properties: { sessionID, textID: `${mid}:t${d.ordinal ?? 0}`, text: d.text },
        },
      ];
    case "session.reasoning.delta":
      if (!sessionID || !mid) return [];
      return [
        {
          type: "session.next.reasoning.delta",
          properties: { sessionID, reasoningID: `${mid}:r${d.ordinal ?? 0}`, delta: d.delta },
        },
      ];
    case "session.tool.input.started": {
      const id = str(d.id);
      if (!sessionID || !id) return [];
      const tool: ToolState = { name: str(d.name) ?? "tool", input: {}, metadata: {}, messageID: mid };
      state.tools.set(id, tool);
      return [partEvent(sessionID, toolPart({ sessionID, messageID: mid, id, tool, status: "pending" }))];
    }
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed": {
      const id = str(d.id);
      if (!sessionID || !id) return [];
      const tool = state.tools.get(id) ?? { name: str(d.name) ?? "tool", input: {}, metadata: {}, messageID: mid };
      state.tools.set(id, tool);
      if (d.input && typeof d.input === "object") tool.input = d.input as Rec;
      if (d.metadata && typeof d.metadata === "object") {
        tool.metadata = { ...tool.metadata, ...(d.metadata as Rec) };
      }
      const status =
        type === "session.tool.success"
          ? "completed"
          : type === "session.tool.failed"
            ? "error"
            : "running";
      const output = contentText(d.content);
      const error = type === "session.tool.failed" ? (errorText(d.error) ?? output ?? "error") : undefined;
      if (status !== "running") state.tools.delete(id);
      return [
        partEvent(
          sessionID,
          toolPart({ sessionID, messageID: tool.messageID ?? mid, id, tool, status, output, error }),
        ),
      ];
    }
    case "session.step.started":
    case "session.step.ended": {
      if (!sessionID || !mid) return [];
      const info = {
        ...(state.steps.get(mid) ?? {}),
        id: mid,
        sessionID,
        role: "assistant",
        ...(str(d.agent) ? { agent: d.agent } : {}),
        ...(d.model ? { ...modelFields(d.model), model: d.model } : {}),
        ...(d.tokens ? { tokens: d.tokens } : {}),
        ...(typeof d.cost === "number" ? { cost: d.cost } : {}),
        time: { created: e.created, ...(type === "session.step.ended" ? { completed: e.created } : {}) },
      };
      state.steps.set(mid, info);
      if (state.steps.size > 200) state.steps.delete(state.steps.keys().next().value as string);
      return [{ type: "message.updated", properties: { sessionID, info } }];
    }
    case "session.execution.started":
      return sessionID
        ? [{ type: "session.status", properties: { sessionID, status: { type: "busy" } } }]
        : [];
    case "session.execution.succeeded":
      return sessionID ? [{ type: "session.idle", properties: { sessionID } }] : [];
    case "session.execution.failed":
      return sessionID
        ? [
            { type: "session.error", properties: { sessionID, error: v1Error(d.error) } },
            { type: "session.idle", properties: { sessionID } },
          ]
        : [];
    case "session.execution.interrupted":
      return sessionID
        ? [
            {
              type: "session.error",
              properties: {
                sessionID,
                error: { name: "MessageAbortedError", data: { message: "Stopped" } },
              },
            },
            { type: "session.idle", properties: { sessionID } },
          ]
        : [];
    case "session.retry.scheduled":
      return sessionID
        ? [
            {
              type: "session.status",
              properties: {
                sessionID,
                status: {
                  type: "retry",
                  attempt: d.attempt,
                  message: errorText(d.error) ?? "Retrying",
                  next: d.at,
                },
              },
            },
          ]
        : [];
    case "session.created":
      return sessionID
        ? [
            {
              type: "session.created",
              properties: {
                sessionID,
                info: {
                  id: sessionID,
                  ...(str(d.parentID) ? { parentID: d.parentID } : {}),
                  ...(str(d.title) ? { title: d.title } : {}),
                },
              },
            },
          ]
        : [];
    case "session.renamed":
      return sessionID
        ? [{ type: "session.updated", properties: { sessionID, info: { id: sessionID, title: d.title } } }]
        : [];
    case "session.revert.staged":
    case "session.revert.cleared":
    case "session.revert.committed":
      return sessionID
        ? [{ type: "session.updated", properties: { sessionID, info: { id: sessionID } } }]
        : [];
    case "session.compaction.ended":
      return sessionID ? [{ type: "session.compacted", properties: { sessionID } }] : [];
    case "permission.asked":
      return [{ type: "permission.asked", properties: v1PermissionAsk(d) }];
    case "form.created": {
      const ask = v1QuestionAsk(d.form);
      return ask ? [{ type: "question.asked", properties: ask }] : [];
    }
    default:
      return [];
  }
}

/** V2 session → V1 session fields the bridge reads. */
export function v1Session(raw: unknown): {
  id: string;
  title?: string;
  directory?: string;
  parentID?: string;
  projectID?: string;
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  time?: { created?: number; updated?: number };
  revert?: unknown;
} {
  const s = rec(raw);
  const location = rec(s.location);
  const model = rec(s.model);
  const time = rec(s.time);
  const revert = s.revert && typeof s.revert === "object" ? rec(s.revert) : undefined;
  return {
    id: String(s.id),
    ...(str(s.title) ? { title: s.title as string } : {}),
    ...(str(location.directory) ? { directory: location.directory as string } : {}),
    ...(str(s.parentID) ? { parentID: s.parentID as string } : {}),
    ...(str(s.projectID) ? { projectID: s.projectID as string } : {}),
    ...(str(s.agent) ? { agent: s.agent as string } : {}),
    ...(str(model.providerID) && str(model.id)
      ? {
          model: {
            providerID: model.providerID as string,
            modelID: model.id as string,
            ...(str(model.variant) ? { variant: model.variant as string } : {}),
          },
        }
      : {}),
    time: { created: time.created as number, updated: time.updated as number },
    ...(revert ? { revert: { ...revert, messageID: revert.messageID ?? revert.to } } : {}),
  };
}

type V1Message = { info: Rec; parts: Rec[] };

/** V2 message list (ascending) → V1 `{ info, parts }[]`. */
export function v1Messages(sessionID: string, messages: readonly unknown[]): V1Message[] {
  const out: V1Message[] = [];
  let agent: string | undefined;
  let model: Rec | undefined;
  for (const raw of messages) {
    const m = rec(raw);
    const id = String(m.id);
    const time = rec(m.time);
    if (m.type === "agent-switched" && str(m.agent)) agent = m.agent as string;
    if (m.type === "model-switched" && m.model) model = rec(m.model);
    if (m.type === "user") {
      const files = Array.isArray(m.files) ? m.files.map(rec) : [];
      out.push({
        info: {
          id,
          sessionID,
          role: "user",
          ...(agent ? { agent } : {}),
          ...(model ? { model: { providerID: model.providerID, modelID: model.id } } : {}),
          // Run chip shows the reasoning level the user sent with (V1 user info had it).
          ...(str(model?.variant) && model?.variant !== "default" ? { variant: model?.variant } : {}),
          time: { created: time.created },
        },
        parts: [
          { id: `${id}:text`, type: "text", text: String(m.text ?? ""), messageID: id, sessionID },
          ...files.map((file, index) => ({
            id: `${id}:file${index}`,
            type: "file",
            url: file.uri,
            filename: file.name,
            messageID: id,
            sessionID,
          })),
        ],
      });
      continue;
    }
    if (m.type !== "assistant") continue;
    if (str(m.agent)) agent = m.agent as string;
    const content = Array.isArray(m.content) ? m.content.map(rec) : [];
    const parts: Rec[] = [];
    content.forEach((c, index) => {
      if (c.type === "text") {
        parts.push({ id: `${id}:t${index}`, type: "text", text: c.text, messageID: id, sessionID });
      } else if (c.type === "reasoning") {
        parts.push({ id: `${id}:r${index}`, type: "reasoning", text: c.text, messageID: id, sessionID });
      } else if (c.type === "tool") {
        const st = rec(c.state);
        const name = str(c.name) ?? "tool";
        const status =
          st.status === "completed" ? "completed" : st.status === "error" ? "error" : "running";
        parts.push(
          toolPart({
            sessionID,
            messageID: id,
            id: String(c.id),
            tool: { name, input: rec(st.input), metadata: rec(st.metadata) },
            status,
            output: contentText(st.content),
            error: status === "error" ? (errorText(st.error) ?? "error") : undefined,
          }),
        );
      }
    });
    out.push({
      info: {
        id,
        sessionID,
        role: "assistant",
        ...(str(m.agent) ? { agent: m.agent } : {}),
        ...modelFields(m.model),
        ...(m.model ? { model: m.model } : {}),
        ...(m.tokens ? { tokens: m.tokens } : {}),
        ...(typeof m.cost === "number" ? { cost: m.cost } : {}),
        ...(m.error ? { error: v1Error(m.error) } : {}),
        ...(str(m.finish) ? { finish: m.finish } : {}),
        time: { created: time.created, ...(time.completed ? { completed: time.completed } : {}) },
      },
      parts,
    });
  }
  return out;
}
