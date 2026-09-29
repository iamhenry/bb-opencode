import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runMessageUndo } from "../src/app/message-revert.js";

const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

describe("OpenCode revert UI registration", () => {
  it("puts Revert from here in the native message action row", () => {
    expect(app).toContain("app.slots.messageAction");
    expect(app).toContain('title: "Revert from here"');
    expect(app).toContain('id: "opencode-revert"');
    expect(app).toContain('icon: "ArrowTurnBackward"');
  });

  it("does not issue an RPC for an assistant action", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      await runMessageUndo({
        threadId: "thread-1",
        messageId: "assistant-1",
        role: "assistant",
        text: "reply",
      });

      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("mounts the reversible-state dock and timeline projection", () => {
    expect(app).toContain('id: "opencode-revert-dock"');
    expect(app).toContain("component: RevertDock");
    expect(app).toContain('id: "opencode-revert-timeline"');
    expect(app).toContain("mountRevertTimeline");
  });
});
