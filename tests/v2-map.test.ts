import { describe, expect, it } from "vitest";
import { createV2EventState, translateV2Event, v1Messages, v1Session } from "../src/v2-map.js";

// Event shapes are the ones OpenCode 2.0.18 emitted in the live BB smokes.
const ses = "ses_1";
const mid = "msg_a";

function translate(events: Array<{ type: string; data: Record<string, unknown> }>) {
  const state = createV2EventState();
  return events.flatMap((event) => translateV2Event(state, { id: "e", created: 1, ...event }));
}

describe("V2 session translation", () => {
  it("preserves current child settings without message history", () => {
    const session = v1Session({
      id: "ses_child",
      parentID: "ses_parent",
      location: { directory: "/project" },
      agent: "smoke-child",
      model: { providerID: "anthropic", id: "claude-haiku-4-5", variant: "high" },
    });
    expect(session).toMatchObject({
      parentID: "ses_parent",
      directory: "/project",
      agent: "smoke-child",
      model: { providerID: "anthropic", modelID: "claude-haiku-4-5", variant: "high" },
    });
  });
});

describe("V2 event translation", () => {
  it("streams assistant text under a stable per-message id", () => {
    const out = translate([
      { type: "session.text.delta", data: { sessionID: ses, assistantMessageID: mid, ordinal: 0, delta: "hi" } },
      { type: "session.text.ended", data: { sessionID: ses, assistantMessageID: mid, ordinal: 0, text: "hi" } },
    ]);
    expect(out).toEqual([
      { type: "session.next.text.delta", properties: { sessionID: ses, textID: `${mid}:t0`, delta: "hi" } },
      { type: "session.next.text.ended", properties: { sessionID: ses, textID: `${mid}:t0`, text: "hi" } },
    ]);
  });

  it("completes a shell call with its output", () => {
    const out = translate([
      { type: "session.tool.input.started", data: { sessionID: ses, assistantMessageID: mid, id: "call_1", name: "shell" } },
      { type: "session.tool.called", data: { sessionID: ses, assistantMessageID: mid, id: "call_1", input: { command: "echo hi" } } },
      {
        type: "session.tool.success",
        data: { sessionID: ses, assistantMessageID: mid, id: "call_1", content: [{ type: "text", text: "hi\n" }], metadata: { exit: 0 } },
      },
    ]);
    const last = out.at(-1)?.properties as { part: Record<string, any> };
    expect(last.part).toMatchObject({
      callID: "call_1",
      type: "tool",
      state: { status: "completed", input: { command: "echo hi" }, output: "hi\n" },
    });
  });

  it("links a subagent call to its child session as a task", () => {
    const out = translate([
      { type: "session.tool.input.started", data: { sessionID: ses, assistantMessageID: mid, id: "call_2", name: "subagent" } },
      {
        type: "session.tool.called",
        data: { sessionID: ses, assistantMessageID: mid, id: "call_2", input: { agent: "general", description: "bg math", prompt: "2+2" } },
      },
      { type: "session.tool.progress", data: { sessionID: ses, id: "call_2", metadata: { sessionID: "ses_child", status: "running" } } },
    ]);
    const part = (out.at(-1)?.properties as { part: Record<string, any> }).part;
    expect(part.tool).toBe("task");
    expect(part.state).toMatchObject({
      status: "running",
      input: { subagent_type: "general", description: "bg math" },
      metadata: { sessionID: "ses_child" },
    });
  });

  it("fails the turn with OpenCode's message and then idles", () => {
    const out = translate([
      { type: "session.execution.failed", data: { sessionID: ses, error: { message: "The usage limit has been reached" } } },
    ]);
    expect(out.map((event) => event.type)).toEqual(["session.error", "session.idle"]);
    expect(JSON.stringify(out[0])).toContain("The usage limit has been reached");
  });

  it("turns a question form into a question with its field key", () => {
    const [event] = translate([
      {
        type: "form.created",
        data: {
          form: {
            id: "frm_1",
            sessionID: ses,
            metadata: { kind: "question", tool: { messageID: mid, id: "call_3" } },
            fields: [
              {
                key: "q0",
                title: "Color",
                description: "Pick one",
                type: "string",
                options: [{ value: "blue", label: "blue" }],
              },
            ],
          },
        },
      },
    ]);
    expect(event).toMatchObject({
      type: "question.asked",
      properties: {
        id: "frm_1",
        questions: [{ question: "Pick one", header: "Color", multiple: false, options: [{ label: "blue" }] }],
        tool: { callID: "call_3" },
        _fields: [{ key: "q0", type: "string" }],
      },
    });
  });

  it("maps a permission request onto the fields the approval card reads", () => {
    const [event] = translate([
      {
        type: "permission.asked",
        data: { id: "per_1", sessionID: ses, action: "shell", resources: ["echo perm"], source: { type: "tool", messageID: mid, id: "call_4" } },
      },
    ]);
    expect(event?.properties).toMatchObject({
      id: "per_1",
      permission: "shell",
      patterns: ["echo perm"],
      tool: { messageID: mid, callID: "call_4" },
    });
  });

  it("keeps the model and reasoning a user message was sent with (run chip)", () => {
    const [first, second] = v1Messages(ses, [
      { id: "m1", type: "model-switched", model: { id: "glm-5.3-flash", providerID: "ollama-cloud", variant: "default" } },
      { id: "u1", type: "user", text: "a", time: { created: 1 } },
      { id: "m2", type: "model-switched", model: { id: "glm-5.3-flash", providerID: "ollama-cloud", variant: "high" } },
      { id: "u2", type: "user", text: "b", time: { created: 2 } },
    ]);
    expect(first?.info).toMatchObject({ role: "user", model: { providerID: "ollama-cloud", modelID: "glm-5.3-flash" } });
    expect(first?.info).not.toHaveProperty("variant");
    expect(second?.info).toMatchObject({ variant: "high" });
  });
});
