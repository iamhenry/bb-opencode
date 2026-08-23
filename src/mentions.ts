import type { OpenCodeAgent } from "./selectable-primaries.js";

export interface MentionItem {
  id: string;
  title: string;
  subtitle?: string;
}

export function listSubagentMentions(
  agents: readonly OpenCodeAgent[],
  query: string,
): MentionItem[] {
  const needle = query.trim().toLowerCase();
  return agents
    .filter((agent) => agent.mode === "subagent" && !agent.hidden)
    .filter((agent) => {
      if (!needle) return true;
      return (
        agent.name.toLowerCase().includes(needle) ||
        (agent.description ?? "").toLowerCase().includes(needle)
      );
    })
    .map((agent) => ({
      id: agent.name,
      title: `@${agent.name}`,
      subtitle: agent.description ?? "OpenCode subagent",
    }));
}

export function mentionResolveContext(itemId: string): { context: string } {
  const name = itemId.replace(/^@/, "").trim();
  if (!name) return { context: "" };
  return {
    context: `The user mentioned OpenCode subagent @${name}. Use the Task tool with that subagent. Do not invent a different agent.`,
  };
}
