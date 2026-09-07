import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { exclusiveKind, resetHoldForTests } from "../src/hold.js";
import {
  hostWrapEntry,
  providerInstallationRun,
  readCliVersion,
  resetLatestCacheForTests,
} from "../src/update.js";

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

function writeFakeBinary(home: string, version: string): string {
  const dir = join(home, ".opencode", "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "version"), `${version}\n`);
  const bin = join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
if (process.argv[2] === "--version") {
  process.stdout.write(fs.readFileSync(path.join(dir, "version"), "utf8"));
  process.exit(0);
}
if (process.argv[2] === "upgrade") {
  fs.writeFileSync(path.join(dir, "argv"), process.argv.slice(2).join("\\n") + "\\n");
  fs.writeFileSync(path.join(dir, "version"), process.argv[3] + "\\n");
  process.exit(0);
}
process.exit(1);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("install wrap packaging", () => {
  afterEach(() => {
    resetLatestCacheForTests();
  });

  it("executes the exact providerInstallationRun command against a disposable CLI", async () => {
    const built = spawnSync("bb", ["plugin", "build"], {
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(built.status, built.stderr || built.stdout).toBe(0);
    const files = [...walk("dist"), ...walk(".bb-plugin"), ...walk("build")];
    const hostFiles = files.filter(
      (path) => /host/i.test(path) && /\.(js|mjs|cjs)$/.test(path),
    );
    expect(hostFiles.some((path) => path.endsWith("host.js"))).toBe(true);
    expect(hostWrapEntry()).toBeTruthy();
    expect(existsSync(hostWrapEntry()!)).toBe(true);

    const home = mkdtempSync(join(tmpdir(), "bb-oc-wrap-"));
    const previousHome = process.env.HOME;
    const previousBin = process.env.OPENCODE_BIN;
    process.env.HOME = home;
    delete process.env.OPENCODE_BIN;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify([{ tag_name: "v1.18.29" }]), {
          status: 200,
        });
      }
      return originalFetch(input);
    }) as typeof fetch;
    try {
      const bin = writeFakeBinary(home, "1.18.21");
      const plan = await providerInstallationRun("update");
      expect(plan.available).toBe(true);
      if (!plan.available) return;
      expect(plan.command.args[0]).toBe(hostWrapEntry());
      expect(existsSync(plan.command.args[0]!)).toBe(true);
      const ok = spawnSync(plan.command.command, plan.command.args, {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, HOME: home },
      });
      expect(ok.status, ok.stderr || ok.stdout).toBe(0);
      expect(readCliVersion(bin)).toBe("1.18.29");
      expect(exclusiveKind()).toBeNull();
      expect(readFileSync(join(home, ".opencode", "bin", "argv"), "utf8")).toBe(
        "upgrade\n1.18.29\n--method\ncurl\n",
      );
      writeFileSync(join(home, ".opencode", "bin", "version"), "1.18.29\n");
      const again = spawnSync(plan.command.command, plan.command.args, {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, HOME: home },
      });
      expect(again.status).toBe(1);
      expect(readCliVersion(bin)).toBe("1.18.29");

      writeFileSync(join(home, ".opencode", "bin", "version"), "1.18.21\n");
      unlinkSync(join(home, ".opencode", "bin", "argv"));
      mkdirSync(join(home, ".bb", "plugins", "opencode"), { recursive: true });
      const mutex = join(home, ".bb", "plugins", "opencode", "opencode.hold.mutex");
      const hold = join(home, ".bb", "plugins", "opencode", "opencode.hold.json");
      const ready = join(home, "thief.ready");
      const thiefJs = join(home, "thief.js");
      writeFileSync(
        thiefJs,
        `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(ready)}, "1");
const hold = ${JSON.stringify(hold)};
const mutex = ${JSON.stringify(mutex)};
const start = Date.now();
while (Date.now() - start < 8000) {
  try {
    const state = JSON.parse(fs.readFileSync(hold, "utf8"));
    if (state.exclusive && state.exclusive.phase === "pending") {
      try {
        fs.writeFileSync(mutex, process.pid + "\\n", { flag: "wx" });
        setTimeout(() => process.exit(0), 4000);
        break;
      } catch {}
    }
  } catch {}
}
`,
      );
      const thief = spawn(process.execPath, [thiefJs], { stdio: "ignore" });
      try {
        const waitStart = Date.now();
        while (!existsSync(ready) && Date.now() - waitStart < 2000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(ready)).toBe(true);
        const blocked = spawnSync(plan.command.command, plan.command.args, {
          encoding: "utf8",
          timeout: 20_000,
          env: { ...process.env, HOME: home },
        });
        expect(blocked.status).toBe(1);
        expect(readCliVersion(bin)).toBe("1.18.21");
        expect(existsSync(join(home, ".opencode", "bin", "argv"))).toBe(false);
      } finally {
        try {
          thief.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    } finally {
      resetHoldForTests();
      globalThis.fetch = originalFetch;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousBin === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = previousBin;
    }
  });
});
