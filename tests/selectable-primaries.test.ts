import { describe, expect, it } from "vitest";
import {
  hydratePickerAgent,
  listSelectablePrimaries,
  pickerOptionsFromAgents,
  resolveContinueAgent,
  type OpenCodeAgent,
} from "../src/selectable-primaries.js";

const fixture: OpenCodeAgent[] = [
  { name: "build", mode: "primary" },
  { name: "plan", mode: "primary" },
  { name: "custom", mode: "primary" },
  { name: "hidden-primary", mode: "primary", hidden: true },
  { name: "explore", mode: "subagent" },
  { name: "title", mode: "primary", hidden: true },
  { name: "compaction", mode: "primary", hidden: true },
];

describe("selectable primaries", () => {
  it("lists only selectable primaries (ISC-28, ISC-29.4)", () => {
    expect(listSelectablePrimaries(fixture).map((agent) => agent.name)).toEqual([
      "build",
      "plan",
      "custom",
    ]);
  });

  it("maps live OpenCode primaries into picker options without a hardcoded list", () => {
    expect(
      pickerOptionsFromAgents([
        ...fixture,
        {
          name: "bb-supervisor",
          mode: "primary",
          description: "Coordinate work across threads",
        },
      ]),
    ).toEqual([
      { name: "build", description: null },
      { name: "plan", description: null },
      { name: "custom", description: null },
      {
        name: "bb-supervisor",
        description: "Coordinate work across threads",
      },
    ]);
  });

  it("hydrates last selectable primary (ISC-29.3)", () => {
    expect(
      hydratePickerAgent({ lastUserAgent: "plan", agents: fixture }),
    ).toEqual({ status: "selected", agent: "plan" });
  });

  it("preserves a listed subagent but defaults hidden or system agents", () => {
    expect(
      hydratePickerAgent({ lastUserAgent: "title", agents: fixture }).agent,
    ).toBe("build");
    expect(
      hydratePickerAgent({ lastUserAgent: "compaction", agents: fixture }).status,
    ).toBe("default");
    expect(
      hydratePickerAgent({ lastUserAgent: "explore", agents: fixture }),
    ).toEqual({ status: "selected", agent: "explore" });
    expect(
      hydratePickerAgent({ lastUserAgent: undefined, agents: fixture }).agent,
    ).toBe("build");
  });

  it("surfaces unknown ids instead of rewriting them", () => {
    expect(
      hydratePickerAgent({ lastUserAgent: "nope", agents: fixture }),
    ).toEqual({ status: "unknown", agent: "nope" });
  });

  it("keeps a session subagent instead of the parent primary", () => {
    expect(
      resolveContinueAgent({
        requested: "build",
        lastUserAgent: "explore",
        agents: fixture,
      }),
    ).toEqual({ ok: true, agent: "explore", inheritSession: true });
    expect(
      resolveContinueAgent({
        requested: "plan",
        lastUserAgent: "build",
        agents: fixture,
      }),
    ).toEqual({ ok: true, agent: "plan", inheritSession: false });
  });
});
