import { isSystemAgentName } from "./identity.js";
import type { OpenCodeAgent } from "./selectable-primaries.js";

export interface MentionItem {
  id: string;
  title: string;
  subtitle?: string;
}

function mentionableAgent(agent: OpenCodeAgent): boolean {
  if (!agent.name || agent.hidden === true) return false;
  if (isSystemAgentName(agent.name)) return false;
  return true;
}

export function listSubagentMentions(
  agents: readonly OpenCodeAgent[],
  query: string,
): MentionItem[] {
  return listAgentMentions(
    agents.filter((agent) => agent.mode === "subagent"),
    query,
  );
}

/** Primaries + subagents. New-compose `@orchestrator` must match. */
export function listAgentMentions(
  agents: readonly OpenCodeAgent[],
  query: string,
): MentionItem[] {
  const needle = query.trim().toLowerCase();
  return agents
    .filter(mentionableAgent)
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
      subtitle:
        agent.description ??
        (agent.mode === "subagent" ? "OpenCode subagent" : "OpenCode agent"),
    }));
}

export function mentionResolveContext(itemId: string): { context: string } {
  const name = itemId.replace(/^@/, "").trim();
  if (!name) return { context: "" };
  return {
    context: `The user mentioned OpenCode agent @${name}. If that name is a subagent, use the Task tool with it. If it is a primary (build, plan, orchestrator), continue as that agent. Do not invent a different agent.`,
  };
}
