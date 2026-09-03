import { describe, expect, it } from "vitest";
import {
  armNextAgent,
  consumeNextAgent,
  createNextAgentStore,
  peekNextAgent,
  resolveComposerProvider,
  resolvePromptAgent,
  UNBOUND_NEXT_AGENT_KEY,
} from "../src/next-agent.js";
import { shouldRenderOpencodeChrome } from "../src/app/visibility.js";

describe("next agent + composer chrome", () => {
  it("consumes a project-scoped agent once", () => {
    const store = createNextAgentStore();
    armNextAgent(store, "proj_1", "plan");
    expect(consumeNextAgent(store, "proj_1")).toBe("plan");
    expect(consumeNextAgent(store, "proj_1")).toBeUndefined();
  });

  it("prefers a stamped agent, then next, then the configured default", () => {
    expect(
      resolvePromptAgent({
        stamped: "plan",
        next: "orchestrator",
        configured: "build",
      }),
    ).toBe("plan");
    expect(
      resolvePromptAgent({ next: "orchestrator", configured: "build" }),
    ).toBe("orchestrator");
    expect(resolvePromptAgent({ configured: "research" })).toBe("research");
    expect(resolvePromptAgent({})).toBe("build");
  });

  it("new-thread picker loses orchestrator when stamp happens after derive", () => {
    const store = createNextAgentStore();
    const duringSubmit = resolvePromptAgent({
      next: consumeNextAgent(store, "proj"),
      configured: "build",
    });
    armNextAgent(store, "proj", "orchestrator");
    expect(duringSubmit).toBe("build");
    expect(consumeNextAgent(store, "proj")).toBe("orchestrator");
  });

  it("new-thread picker keeps orchestrator when stamp happens before derive", () => {
    const store = createNextAgentStore();
    armNextAgent(store, "proj", "orchestrator");
    expect(
      resolvePromptAgent({
        next: consumeNextAgent(store, "proj"),
        configured: "build",
      }),
    ).toBe("orchestrator");
  });

  it("peeking survives a second session/turn derive (consume does not)", () => {
    const store = createNextAgentStore();
    armNextAgent(store, "proj", "orchestrator");
    const firstConsume = resolvePromptAgent({
      next: consumeNextAgent(store, "proj"),
      configured: "build",
    });
    const secondConsume = resolvePromptAgent({
      next: consumeNextAgent(store, "proj"),
      configured: "build",
    });
    expect(firstConsume).toBe("orchestrator");
    expect(secondConsume).toBe("build");

    const peekStore = createNextAgentStore();
    armNextAgent(peekStore, "proj", "orchestrator");
    const firstPeek = resolvePromptAgent({
      next: peekNextAgent(peekStore, "proj"),
      configured: "build",
    });
    const secondPeek = resolvePromptAgent({
      next: peekNextAgent(peekStore, "proj"),
      configured: "build",
    });
    expect(firstPeek).toBe("orchestrator");
    expect(secondPeek).toBe("orchestrator");
  });

  it("unbound compose pick survives derive onto proj_personal", () => {
    const store = createNextAgentStore();
    armNextAgent(store, UNBOUND_NEXT_AGENT_KEY, "orchestrator");
    expect(
      resolvePromptAgent({
        next: peekNextAgent(store, "proj_personal"),
        configured: "build",
      }),
    ).toBe("orchestrator");
  });

  it("hides chrome unless the resolved provider is opencode (ISC-8)", () => {
    expect(
      shouldRenderOpencodeChrome(
        resolveComposerProvider({ threadProviderId: "claude-code" }),
      ),
    ).toBe(false);
    expect(
      shouldRenderOpencodeChrome(
        resolveComposerProvider({ projectDefaultProviderId: "ollama-cloud" }),
      ),
    ).toBe(false);
    expect(
      shouldRenderOpencodeChrome(
        resolveComposerProvider({ threadProviderId: "opencode" }),
      ),
    ).toBe(true);
    expect(
      shouldRenderOpencodeChrome(
        resolveComposerProvider({ projectDefaultProviderId: "opencode" }),
      ),
    ).toBe(true);
    expect(
      shouldRenderOpencodeChrome(
        resolveComposerProvider({ composeKind: "new-thread" }),
      ),
    ).toBe(false);
    expect(
      shouldRenderOpencodeChrome(
        resolveComposerProvider({
          composeKind: "new-thread",
          projectDefaultProviderId: "opencode",
        }),
      ),
    ).toBe(true);
    expect(
      shouldRenderOpencodeChrome(
        resolveComposerProvider({
          composeKind: "new-thread",
          projectDefaultProviderId: "ollama-cloud",
        }),
      ),
    ).toBe(false);
  });
});
