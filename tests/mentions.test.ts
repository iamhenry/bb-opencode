import { describe, expect, it } from "vitest";
import {
  listAgentMentions,
  listSubagentMentions,
  mentionResolveContext,
} from "../src/mentions.js";

describe("OpenCode mentions", () => {
  it("lists only subagents and resolves hidden Task context", () => {
    const items = listSubagentMentions(
      [
        { name: "build", mode: "primary" },
        { name: "explore", mode: "subagent", description: "Scout the repo" },
        { name: "general", mode: "subagent" },
        { name: "hidden", mode: "subagent", hidden: true },
      ],
      "ex",
    );
    expect(items).toEqual([
      { id: "explore", title: "@explore", subtitle: "Scout the repo" },
    ]);
    expect(mentionResolveContext("explore").context).toContain("@explore");
    expect(mentionResolveContext("explore").context).toContain("Task");
  });

  it("matches @orchestrator on new-compose queries", () => {
    expect(
      listAgentMentions(
        [
          { name: "build", mode: "primary" },
          { name: "orchestrator", mode: "primary", description: "Orchestrator primary" },
          { name: "explore", mode: "subagent" },
          { name: "title", mode: "primary", hidden: true },
        ],
        "orchestra",
      ),
    ).toEqual([
      {
        id: "orchestrator",
        title: "@orchestrator",
        subtitle: "Orchestrator primary",
      },
    ]);
  });
});
