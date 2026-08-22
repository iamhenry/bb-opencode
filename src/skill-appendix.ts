export interface SkillConfigureRoot {
  id?: string;
  path?: string;
  skills?: Array<{ name?: string; description?: string }>;
}

export function formatSkillAppendix(
  roots: readonly SkillConfigureRoot[],
): string | null {
  const lines: string[] = [];
  for (const root of roots) {
    const skills = Array.isArray(root.skills) ? root.skills : [];
    for (const skill of skills) {
      if (!skill?.name) continue;
      const description =
        typeof skill.description === "string" && skill.description.length > 0
          ? skill.description
          : "No description";
      const path =
        typeof root.path === "string" && root.path.length > 0
          ? ` (${root.path})`
          : "";
      lines.push(`- ${skill.name}: ${description}${path}`);
    }
  }
  if (lines.length === 0) return null;
  return ["## BB skills available in this thread", ...lines].join("\n");
}
