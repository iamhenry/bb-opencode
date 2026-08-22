import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("OpenCode provider mark", () => {
  it("uses currentColor inline and explicit light/dark logos", () => {
    const icon = readFileSync(join(root, "src/app/provider-icon.tsx"), "utf8");
    expect(icon).toContain('fill="currentColor"');
    expect(icon).toContain('viewBox="-72 -42 384 384"');

    const mask = readFileSync(join(root, "assets/icon.svg"), "utf8");
    expect(mask).toContain('fill="currentColor"');

    const light = readFileSync(join(root, "assets/logo-light.svg"), "utf8");
    const dark = readFileSync(join(root, "assets/logo-dark.svg"), "utf8");
    expect(light).toContain("#171717");
    expect(dark).toContain("#fafafa");
    expect(light).not.toContain("currentColor");
    expect(dark).not.toContain("currentColor");
  });
});
