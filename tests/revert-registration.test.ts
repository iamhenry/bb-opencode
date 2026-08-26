import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

describe("OpenCode revert UI registration", () => {
  it("puts Revert from here in the native message action row", () => {
    expect(app).toContain("app.slots.messageAction");
    expect(app).toContain('title: "Revert from here"');
    expect(app).toContain('id: "opencode-revert"');
  });

  it("mounts the reversible-state dock and timeline projection", () => {
    expect(app).toContain('id: "opencode-revert-dock"');
    expect(app).toContain("component: RevertDock");
    expect(app).toContain('id: "opencode-revert-timeline"');
    expect(app).toContain("mountRevertTimeline");
  });
});
