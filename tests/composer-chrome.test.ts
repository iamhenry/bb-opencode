import { describe, expect, it } from "vitest";
import {
  composerAgentShouldArm,
  displayedComposerAgent,
  fetchComposerChrome,
  lastArmedComposerAgent,
  rememberComposerAgent,
  resetComposerChromeInflight,
  resetLastArmedComposerAgent,
  shouldApplyHydratedAgent,
  shouldResetArmedComposerAgent,
} from "../src/app/composer-chrome.js";

const hidden = {
  providerId: null,
  status: "hidden" as const,
  agent: "",
  options: [],
  error: null,
};

describe("fetchComposerChrome", () => {
  it("shares one in-flight RPC per thread/project", async () => {
    resetComposerChromeInflight();
    let calls = 0;
    const call = () => {
      calls += 1;
      return new Promise<typeof hidden>((resolve) => {
        setTimeout(() => resolve(hidden), 20);
      });
    };
    const input = { threadId: "thr_1", projectId: "prj_1" };
    const [a, b] = await Promise.all([
      fetchComposerChrome(call, input),
      fetchComposerChrome(call, input),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("does not let chrome hydrate overwrite a picker click", () => {
    expect(
      shouldApplyHydratedAgent({
        userPicked: false,
        chromeStatus: "default",
        chromeAgent: "build",
      }),
    ).toBe(true);
    expect(
      shouldApplyHydratedAgent({
        userPicked: true,
        chromeStatus: "default",
        chromeAgent: "build",
      }),
    ).toBe(false);
  });

  it("keeps the armed agent when chrome still reports default after send", () => {
    expect(
      shouldApplyHydratedAgent({
        userPicked: false,
        chromeStatus: "default",
        chromeAgent: "build",
        armedAgent: "orchestrator",
      }),
    ).toBe(false);
    expect(
      shouldApplyHydratedAgent({
        userPicked: false,
        chromeStatus: "selected",
        chromeAgent: "orchestrator",
        armedAgent: "orchestrator",
      }),
    ).toBe(true);
  });

  it("keeps the last pick across new-thread remount, not across thread hops", () => {
    resetLastArmedComposerAgent();
    rememberComposerAgent("orchestrator");
    expect(lastArmedComposerAgent()).toBe("orchestrator");
    expect(shouldResetArmedComposerAgent(null, "thr_1")).toBe(false);
    expect(shouldResetArmedComposerAgent("thr_1", "thr_2")).toBe(true);
    expect(shouldResetArmedComposerAgent("thr_1", null)).toBe(false);
    resetLastArmedComposerAgent();
    expect(lastArmedComposerAgent()).toBe("");
  });

  it("arms the visible chip on new-thread without a click", () => {
    expect(
      composerAgentShouldArm({ visible: true, agent: "orchestrator" }),
    ).toBe(true);
    expect(
      composerAgentShouldArm({ visible: false, agent: "orchestrator" }),
    ).toBe(false);
    expect(composerAgentShouldArm({ visible: true, agent: "  " })).toBe(false);
  });

  it("displays an inherited session agent outside the primary options", () => {
    expect(
      displayedComposerAgent(
        [{ name: "build", description: null }],
        "atlas",
        "selected",
      ),
    ).toEqual({ name: "atlas", description: null });
  });
});
