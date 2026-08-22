import { describe, expect, it } from "vitest";
import {
  armNextAgent,
  consumeNextAgent,
  createNextAgentStore,
  resolveComposerProvider,
  resolvePromptAgent,
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
    ).toBe(true);
    expect(
      shouldRenderOpencodeChrome(
        resolveComposerProvider({
          composeKind: "new-thread",
          projectDefaultProviderId: "ollama-cloud",
        }),
      ),
    ).toBe(true);
  });
});
