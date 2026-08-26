import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { opencodeNativeRoots } from "../src/native-roots.js";

describe("opencodeNativeRoots", () => {
  it("lists user OpenCode skill and command dirs", () => {
    const roots = opencodeNativeRoots({ cwd: null, homeDir: "/test-home" });
    expect(roots.skills).toEqual([
      {
        origin: "user",
        path: join("/test-home", ".config", "opencode", "skills"),
        recursive: true,
        shape: "skills",
      },
    ]);
    expect(roots.commands).toEqual([
      {
        origin: "user",
        path: join("/test-home", ".config", "opencode", "commands"),
        recursive: true,
        shape: "commands",
      },
    ]);
  });

  it("adds project .opencode dirs when cwd is set", () => {
    const roots = opencodeNativeRoots({
      cwd: "/proj",
      homeDir: "/test-home",
    });
    expect(roots.skills.map((root) => root.path)).toEqual([
      join("/test-home", ".config", "opencode", "skills"),
      join("/proj", ".opencode", "skills"),
    ]);
    expect(roots.commands.map((root) => root.path)).toEqual([
      join("/test-home", ".config", "opencode", "commands"),
      join("/proj", ".opencode", "commands"),
    ]);
    expect(roots.skills[1]?.ancestors).toBe(true);
    expect(roots.commands[1]?.ancestors).toBe(true);
  });
});
