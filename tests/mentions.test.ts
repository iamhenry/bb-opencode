import { describe, expect, it } from "vitest";
import {
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
});
