import { afterEach, describe, expect, it } from "vitest";
import { handleLine, resetBridgeForTests } from "../src/bridge.js";
import { createFakeOpenCode } from "./fake-opencode.js";

const fullOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

function send(message: Record<string, unknown>): void {
  handleLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("OC-14 repro: child-agent model selection", () => {
  const messages: Array<Record<string, unknown>> = [];

  afterEach(() => {
    resetBridgeForTests();
    messages.length = 0;
  });

  function installFake() {
    const fake = createFakeOpenCode();
    resetBridgeForTests({
      acquire: () => fake.client,
      attach: async () => ({ url: fake.client.url, pid: 1, port: 9 }),
      write: (message) => messages.push(message),
    });
    return fake;
  }

  /**
   * Scenario: parent (bb-supervisor, openai/gpt-6-astra) finishes a turn, then
   * BB dispatches the NEXT turn for a cheap Mission Lead (agent with configured
   * model ollama-cloud/glm-5.3-flash) WITHOUT an explicit options.model.
   *
   * Expected (per SDK precedence): agent-configured model applies.
   * Bug (fixed): bridge used to resolve model from lastPrompted (parent's Astra).
   */
  it("regression: turn without explicit options.model omits model so agent config applies (OC-14)", async () => {
    const fake = installFake();
    fake.agents.push(
      { name: "bb-supervisor", mode: "primary" },
      { name: "general", mode: "primary" },
    );

    // Turn 1: parent primary agent (bb-supervisor) explicitly pinned to Astra.
    send({
      id: "start",
      method: "thread/start",
      params: {
        threadId: "thr_parent",
        cwd: "/tmp/a",
        instructionMode: "append",
        options: fullOptions,
      },
    });
    await flush();
    send({
      id: "turn1",
      method: "turn/start",
      params: {
        threadId: "thr_parent",
        providerThreadId: "ses_1",
        clientRequestId: "req_1",
        input: [{ type: "text", text: "supervise", mentions: [] }],
        options: {
          ...fullOptions,
          model: "openai/gpt-6-astra",
          providerOptions: { agent: "bb-supervisor" },
        },
      },
    });
    await flush();
    const deltas1 = messages.flatMap(
      (message) =>
        ((message.params as { deltas?: Array<Record<string, unknown>> })
          ?.deltas ?? []),
    );
    // eslint-disable-next-line no-console
    console.log("turn1 deltas:", JSON.stringify(deltas1));
    expect(fake.lastPrompt).toBeDefined();

    // Turn 2: SAME session, Mission Lead agent, NO explicit model from BB.
    send({
      id: "turn2",
      method: "turn/start",
      params: {
        threadId: "thr_parent",
        providerThreadId: "ses_1",
        clientRequestId: "req_2",
        input: [{ type: "text", text: "mission lead turn", mentions: [] }],
        options: { ...fullOptions, providerOptions: { agent: "general" } },
      },
    });
    await flush();

    const secondModel = fake.lastPrompt?.body.model;
    // Agent config must win: the bridge must NOT inject the remembered
    // (parent's) model. Omitted model => OpenCode server applies agent config.
    expect(secondModel).toBeUndefined();
  });
});