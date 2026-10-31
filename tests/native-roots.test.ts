import { dirname, join } from "node:path";
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
      {
        origin: "user",
        path: join("/test-home", ".config", "opencode", "command"),
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
      join("/test-home", ".config", "opencode", "command"),
      join("/proj", ".opencode", "commands"),
      join("/proj", ".opencode", "command"),
    ]);
    expect(roots.skills[1]?.ancestors).toBe(true);
    expect(roots.commands[1]?.ancestors).toBeUndefined();
    expect(roots.commands[2]?.ancestors).toBe(true);
    expect(roots.commands[3]?.ancestors).toBe(true);
  });

  it("adds plugin skill files without duplicating scanned skills or built-ins", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "opencode-native-roots-"));
    try {
      const cwd = join(homeDir, "project", "nested");
      const userPlugin = join(homeDir, ".config", "opencode", "plugins", "hivecall", "SKILL.md");
      const projectPlugin = join(cwd, ".opencode", "plugins", "local", "SKILL.md");
      const scanned = [
        join(homeDir, ".config", "opencode", "skills", "verification-gate", "SKILL.md"),
        join(cwd, ".opencode", "skills", "current", "SKILL.md"),
        join(homeDir, "project", ".opencode", "skills", "ancestor", "SKILL.md"),
      ];
      for (const file of [userPlugin, projectPlugin, ...scanned]) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "---\nname: example\n---\nSkill body");
      }
      const base = opencodeNativeRoots({ cwd, homeDir });
      const roots = opencodeNativeRoots({
        cwd,
        homeDir,
        discoveredSkills: [
          { id: "hivecall", path: userPlugin },
          { id: "hivecall", path: userPlugin },
          { id: "local", location: projectPlugin },
          { path: "/builtin/opencode.md" },
          { path: "<built-in>" },
          ...scanned.map((path) => ({ path })),
          { path: join(homeDir, "missing.md") },
          { path: cwd },
          null,
          { path: 42 },
        ],
      });
      expect(roots).toEqual({
        commands: base.commands,
        skills: [
          ...base.skills,
          { origin: "user", path: userPlugin, recursive: false, shape: "skill-file", fallbackName: "hivecall" },
          { origin: "project", path: projectPlugin, recursive: false, shape: "skill-file", fallbackName: "local" },
        ],
      });
      expect(opencodeNativeRoots({ cwd, homeDir, discoveredSkills: { invalid: true } })).toEqual(base);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
