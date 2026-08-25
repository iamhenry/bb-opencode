import { join } from "node:path";

export type NativeRoot = {
  origin: "project" | "user";
  path: string;
  recursive: boolean;
  ancestors?: boolean;
  shape: "skills" | "commands";
};

/** OpenCode skill + command dirs BB should scan for the native `/` picker. */
export function opencodeNativeRoots(args: {
  cwd: string | null;
  homeDir: string;
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
  }
  return { skills, commands };
}
