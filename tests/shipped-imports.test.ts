import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("shipped import rules", () => {
  it("does not import private @bb packages from shipped entries (ISC-3)", () => {
    for (const file of ["server.ts", "host.ts", "app.tsx"]) {
      expect(read(file)).not.toMatch(/from ['"]@bb\//);
      expect(read(file)).not.toMatch(/require\(['"]@bb\//);
    }
  });

  it("imports @opencode-ai/sdk only from the host client module (ISC-4)", () => {
    expect(read("server.ts")).not.toContain("@opencode-ai/sdk");
    expect(read("app.tsx")).not.toContain("@opencode-ai/sdk");
    expect(read("src/client.ts")).toContain("@opencode-ai/sdk");
  });

  it("keeps conformance off the shipped graph (ISC-5)", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@get-bb/plugin-sdk"]).toBeUndefined();
    expect(read("server.ts")).not.toContain("provider-bridge-protocol/conformance");
    expect(read("host.ts")).not.toContain("provider-bridge-protocol/conformance");
    expect(read("app.tsx")).not.toContain("provider-bridge-protocol/conformance");
  });

  it("does not use session.events, pendingInteraction, or messageDirective (ISC-23, 38, 39)", () => {
    const bridge = read("src/bridge.ts");
    expect(bridge).not.toContain("session.events");
    expect(bridge).not.toContain("pendingInteraction");
    expect(bridge).not.toContain("requestInput");
    expect(bridge).not.toContain("messageDirective");
  });

  it("does not rewrite @subagent mentions (ISC-77)", () => {
    expect(read("src/prompt-builder.ts")).not.toContain("session.subagent");
    expect(read("src/bridge.ts")).not.toContain("session.subagent");
    expect(read("src/prompt-builder.ts")).not.toContain("switchAgent");
  });

  it("does not write opencode.json to inject skills (ISC-87)", () => {
    for (const file of [
      "src/bridge.ts",
      "src/client.ts",
      "src/skill-appendix.ts",
      "server.ts",
      "host.ts",
    ]) {
      const text = read(file);
      expect(text).not.toMatch(/writeFile.*opencode\.json/);
      expect(text).not.toContain("skills.paths");
    }
  });

  it("slash autocomplete uses OpenCode visibility (ISC-88)", () => {
    const picker = read("src/app/composer-command.tsx");
    expect(picker).toContain("shouldRenderOpencodeChrome");
    expect(picker).toContain("newThreadShowsOpencodeAgent");
    expect(read("app.tsx")).not.toContain('id: "command"');
  });

  it("does not issue session.command from slash autocomplete (ISC-89)", () => {
    const picker = read("src/app/composer-command.tsx");
    expect(picker).toContain("insertCommandToken");
    expect(picker).toContain("slashAutocompleteQuery");
    expect(picker).not.toContain("session.command");
    expect(picker).not.toContain("sessionCommand");
  });

  it("does not issue RPC from picker onChange (ISC-29.2)", () => {
    const picker = read("src/app/composer-agent.tsx");
    expect(picker).toMatch(/onChange=\{\(event\) => \{\s*setAgent/);
    expect(picker).not.toContain("switchAgent");
    expect(picker).not.toContain("noReply");
  });
});
