import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt-builder.js";

describe("prompt builder", () => {
  it("includes agent on every construction (ISC-29.1)", () => {
    const built = buildPrompt({
      agent: "build",
      input: [{ type: "text", text: "hello" }],
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.prompt.agent).toBe("build");
      expect(built.prompt.parts[0]).toEqual({ type: "text", text: "hello" });
    }
  });

  it("maps a supported local file (ISC-65)", () => {
    const built = buildPrompt({
      agent: "plan",
      input: [
        { type: "text", text: "see" },
        { type: "localFile", path: "/tmp/note.md", name: "note.md" },
      ],
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.prompt.parts.some((part) => part.type === "file")).toBe(true);
    }
  });

  it("puts BB project instructions on system, not a user part", () => {
    const built = buildPrompt({
      agent: "build",
      instructions: "use bun",
      input: [{ type: "text", text: "hello" }],
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.prompt.parts).toEqual([{ type: "text", text: "hello" }]);
      expect(built.prompt.system).toContain("[BB project instructions]");
      expect(built.prompt.system).toContain("use bun");
    }
  });

  it("fails the whole send on an unsupported attachment (ISC-21)", () => {
    const built = buildPrompt({
      agent: "build",
      input: [{ type: "directory", path: "/tmp" }],
    });
    expect(built.ok).toBe(false);
  });
});
