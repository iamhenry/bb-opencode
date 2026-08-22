import { describe, expect, it } from "vitest";
import {
  createAgentStampStore,
  peekAgent,
  settleTurn,
  stampAgent,
} from "../src/agent-stamp.js";

describe("agent stamp", () => {
  it("keeps the enqueue agent across a later picker flip (ISC-29.5)", () => {
    const store = createAgentStampStore();
    stampAgent(store, { threadId: "t", agent: "build", queued: true });
    stampAgent(store, { threadId: "t", agent: "plan", queued: false });
    expect(peekAgent(store, "t")).toBe("build");
    settleTurn(store, "t");
    expect(peekAgent(store, "t")).toBe("plan");
  });
});
