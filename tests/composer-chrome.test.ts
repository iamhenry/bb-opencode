import { describe, expect, it } from "vitest";
import {
  displayedComposerAgent,
  fetchComposerChrome,
  resetComposerChromeInflight,
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
