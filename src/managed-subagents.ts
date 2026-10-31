import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";

export const MANAGED_SUBAGENT_PLUGIN_ID = "bb-background-subagents";

// Like OpenChamber's managed plugins, this package needs no imports or install.
export const SUBAGENT_PLUGIN_SOURCE = `export default {
  id: "${MANAGED_SUBAGENT_PLUGIN_ID}",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "subagent") return;
      const visited = new Set();
      let sessionID = event.sessionID;
      while (sessionID && !visited.has(sessionID)) {
        visited.add(sessionID);
        const entries = await ctx.session.instructions.entry.list({ sessionID });
        if (entries.some((entry) => entry.key === "bb")) {
          event.input.background = true;
          return;
        }
        sessionID = (await ctx.session.get({ sessionID })).parentID;
      }
    });
  },
};
`;

function writeChanged(path: string, text: string): void {
  try {
    if (readFileSync(path, "utf8") === text) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Only BB-owned runtime files; never alter an OpenCode user config or plugin folder. */
export function managedServiceEnvironment(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const directory = join(dataDir, MANAGED_SUBAGENT_PLUGIN_ID);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeChanged(join(directory, "package.json"), `${JSON.stringify({
    name: MANAGED_SUBAGENT_PLUGIN_ID,
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { ".": "./index.js" },
  }, null, 2)}\n`);
  writeChanged(join(directory, "index.js"), SUBAGENT_PLUGIN_SOURCE);

  const configPath = join(dataDir, "opencode.managed.json");
  if (!env.OPENCODE_CONFIG?.trim() || env.OPENCODE_CONFIG === configPath) {
    writeChanged(configPath, `${JSON.stringify({ plugins: [directory] }, null, 2)}\n`);
    return { OPENCODE_CONFIG: configPath };
  }

  // The user owns OPENCODE_CONFIG. Preserve it, and extend only the child's env.
  const errors: ParseError[] = [];
  const config: unknown = parse(env.OPENCODE_CONFIG_CONTENT?.trim() || "{}", errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must be a valid JSONC object to load BB's subagent policy");
  }
  const value = config as Record<string, unknown>;
  for (const key of ["plugin", "plugins"]) {
    if (value[key] !== undefined && !Array.isArray(value[key])) {
      throw new Error(`OPENCODE_CONFIG_CONTENT ${key} must be an array to load BB's subagent policy`);
    }
  }
  const configured = [...(value.plugin as unknown[] ?? []), ...(value.plugins as unknown[] ?? [])];
  delete value.plugin;
  value.plugins = [...configured.filter((entry) => {
    const path = Array.isArray(entry) ? entry[0] : entry && typeof entry === "object" ? (entry as Record<string, unknown>).package : entry;
    return path !== directory;
  }), directory];
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(value) };
}
