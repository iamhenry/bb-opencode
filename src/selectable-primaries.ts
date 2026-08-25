import { isSystemAgentName } from "./identity.js";

export interface OpenCodeAgent {
  name: string;
  mode?: string;
  hidden?: boolean;
  native?: boolean;
  description?: string;
}

export function isSelectablePrimary(agent: OpenCodeAgent): boolean {
  if (!agent.name) return false;
  if (agent.hidden === true) return false;
  if (isSystemAgentName(agent.name)) return false;
  if (agent.mode === "subagent") return false;
  return agent.mode === "primary" || agent.mode === "all";
}

export function listSelectablePrimaries(
  agents: readonly OpenCodeAgent[],
): OpenCodeAgent[] {
  return agents.filter(isSelectablePrimary);
}

export function defaultPrimary(
  agents: readonly OpenCodeAgent[],
): OpenCodeAgent | undefined {
  const selectable = listSelectablePrimaries(agents);
  return selectable.find((agent) => agent.name === "build") ?? selectable[0];
}

export type HydrateAgentResult =
  | { status: "selected"; agent: string }
  | { status: "default"; agent: string }
  | { status: "unknown"; agent: string };

export function hydratePickerAgent(args: {
  lastUserAgent: string | undefined;
  agents: readonly OpenCodeAgent[];
}): HydrateAgentResult {
  const fallback = defaultPrimary(args.agents);
  if (!fallback) {
    return { status: "unknown", agent: args.lastUserAgent ?? "" };
  }
  if (!args.lastUserAgent) {
    return { status: "default", agent: fallback.name };
  }
  const match = args.agents.find((agent) => agent.name === args.lastUserAgent);
  if (!match) {
    return { status: "unknown", agent: args.lastUserAgent };
  }
  if (isSelectablePrimary(match)) {
    return { status: "selected", agent: match.name };
  }
  return { status: "default", agent: fallback.name };
}

function listedUsableAgent(
  agents: readonly OpenCodeAgent[],
  name: string | undefined,
): OpenCodeAgent | undefined {
  if (!name) return undefined;
  const match = agents.find((agent) => agent.name === name);
  if (!match || match.hidden === true || isSystemAgentName(match.name)) {
    return undefined;
  }
  return match;
}

/** Prompt agent for an existing session. Subagent children keep their agent. */
export function resolveContinueAgent(args: {
  requested?: string;
  lastUserAgent?: string;
  agents: readonly OpenCodeAgent[];
}):
  | { ok: true; agent: string; inheritSession: boolean }
  | { ok: false; reason: string } {
  const last = listedUsableAgent(args.agents, args.lastUserAgent);
  if (last?.mode === "subagent") {
    return { ok: true, agent: last.name, inheritSession: true };
  }
  if (args.requested) {
    if (
      listSelectablePrimaries(args.agents).some(
        (agent) => agent.name === args.requested,
      )
    ) {
      return { ok: true, agent: args.requested, inheritSession: false };
    }
    return {
      ok: false,
      reason: `Unknown or non-selectable OpenCode agent: ${args.requested}`,
    };
  }
  const hydrated = hydratePickerAgent({
    lastUserAgent: args.lastUserAgent,
    agents: args.agents,
  });
  if (hydrated.status === "unknown") {
    return {
      ok: false,
      reason: `Unknown OpenCode agent: ${hydrated.agent}`,
    };
  }
  return { ok: true, agent: hydrated.agent, inheritSession: false };
}
