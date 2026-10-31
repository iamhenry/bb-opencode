import { statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { endpointHeadersFor } from "./client.js";
import { serviceInfo } from "./process.js";

export type NativeRoot = {
  origin: "project" | "user";
  path: string;
  recursive: boolean;
  ancestors?: boolean;
  shape: "skills" | "commands" | "skill-file";
  fallbackName?: string;
};

/** OpenCode skill + command dirs BB should scan for the native `/` picker. */
export function opencodeNativeRoots(args: {
  cwd: string | null;
  homeDir: string;
  discoveredSkills?: unknown;
}): { skills: NativeRoot[]; commands: NativeRoot[] } {
  const skills: NativeRoot[] = [
    {
      origin: "user",
      path: join(args.homeDir, ".config", "opencode", "skills"),
      recursive: true,
      shape: "skills",
    },
  ];
  const commands: NativeRoot[] = [
    {
      origin: "user",
      path: join(args.homeDir, ".config", "opencode", "commands"),
      recursive: true,
      shape: "commands",
    },
    {
      origin: "user",
      path: join(args.homeDir, ".config", "opencode", "command"),
      recursive: true,
      shape: "commands",
    },
  ];
  if (args.cwd) {
    skills.push({
      origin: "project",
      path: join(args.cwd, ".opencode", "skills"),
      recursive: true,
      ancestors: true,
      shape: "skills",
    });
    commands.push({
      origin: "project",
      path: join(args.cwd, ".opencode", "commands"),
      recursive: true,
      ancestors: true,
      shape: "commands",
    });
    commands.push({
      origin: "project",
      path: join(args.cwd, ".opencode", "command"),
      recursive: true,
      ancestors: true,
      shape: "commands",
    });
  }
  if (Array.isArray(args.discoveredSkills)) {
    const scanned = skills.map((root) => root.path);
    // BB also scans project skill roots in every ancestor of cwd.
    if (args.cwd) {
      for (let dir = dirname(args.cwd); ; dir = dirname(dir)) {
        scanned.push(join(dir, ".opencode", "skills"));
        if (dirname(dir) === dir) break;
      }
    }
    const added = new Set<string>();
    for (const item of args.discoveredSkills) {
      const path = item?.path ?? item?.location;
      if (typeof path !== "string" || !isAbsolute(path) || path.startsWith("/builtin/")) continue;
      const file = resolve(path);
      if (added.has(file) || scanned.some((root) => isWithin(root, file))) continue;
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      skills.push({
        origin: args.cwd && isWithin(args.cwd, file) ? "project" : "user",
        path: file,
        recursive: false,
        shape: "skill-file",
        ...(typeof item.id === "string" && item.id ? { fallbackName: item.id } : {}),
      });
      added.add(file);
    }
  }
  return { skills, commands };
}

function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Runtime plugins can register skill files outside OpenCode's usual folders. */
export async function resolveOpenCodeNativeRoots(args: {
  cwd: string | null;
  homeDir: string;
}): Promise<{ skills: NativeRoot[]; commands: NativeRoot[] }> {
  const roots = opencodeNativeRoots(args);
  try {
    const service = await serviceInfo();
    if (!service) return roots;
    const response = await fetch(`${service.url}/api/skill`, {
      headers: {
        ...endpointHeadersFor(service.url),
        ...(args.cwd ? { "x-opencode-directory": encodeURIComponent(args.cwd) } : {}),
      },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return roots;
    const body = await response.json();
    return opencodeNativeRoots({ ...args, discoveredSkills: body?.data });
  } catch {
    return roots;
  }
}
