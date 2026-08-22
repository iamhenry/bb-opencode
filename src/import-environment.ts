export interface ImportProject {
  id: string;
  personal?: boolean;
  paths: string[];
}

export interface ImportEnvironmentDecision {
  projectId: string;
  environment:
    | { type: "project-default" }
    | {
        type: "host";
        hostId: string;
        workspace: { type: "unmanaged"; path: string };
      };
}

export function normalizePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

export function resolveImportEnvironment(args: {
  directory: string;
  hostId: string;
  currentProjectId: string;
  projects: readonly ImportProject[];
}): ImportEnvironmentDecision {
  const directory = normalizePath(args.directory);
  const personal =
    args.projects.find((project) => project.personal) ??
    args.projects.find((project) => project.id === args.currentProjectId);

  for (const project of args.projects) {
    if (project.paths.some((path) => normalizePath(path) === directory)) {
      return {
        projectId: project.id,
        environment: { type: "project-default" },
      };
    }
  }

  for (const project of args.projects) {
    if (
      project.paths.some((path) => {
        const root = normalizePath(path);
        return directory === root || directory.startsWith(`${root}/`);
      })
    ) {
      return {
        projectId: project.id,
        environment: {
          type: "host",
          hostId: args.hostId,
          workspace: { type: "unmanaged", path: directory },
        },
      };
    }
  }

  return {
    projectId: personal?.id ?? args.currentProjectId,
    environment: {
      type: "host",
      hostId: args.hostId,
      workspace: { type: "unmanaged", path: directory },
    },
  };
}
