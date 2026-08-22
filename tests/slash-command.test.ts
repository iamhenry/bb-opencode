import { describe, expect, it } from "vitest";
import {
  filterListedCommands,
  hasNonTextParts,
  insertCommandToken,
  matchListedCommand,
  parseLeadingSlash,
  slashAutocompleteQuery,
} from "../src/slash-command.js";
import { formatSkillAppendix } from "../src/skill-appendix.js";

describe("slash commands", () => {
  it("parses /name args", () => {
    expect(parseLeadingSlash("/init")).toEqual({ name: "init", arguments: "" });
    expect(parseLeadingSlash("  /isa/product-isa  do it ")).toEqual({
      name: "isa/product-isa",
      arguments: "do it",
    });
  });

  it("ignores non-commands", () => {
    expect(parseLeadingSlash("please /init")).toBeNull();
    expect(parseLeadingSlash("// comment")).toBeNull();
    expect(parseLeadingSlash("init")).toBeNull();
  });

  it("matches only listed names (ISC-82)", () => {
    const listed = [{ name: "init" }, { name: "review" }];
    expect(matchListedCommand("init", listed)?.name).toBe("init");
    expect(matchListedCommand("nope", listed)).toBeUndefined();
  });

  it("exposes a leading slash token as an autocomplete query", () => {
    expect(slashAutocompleteQuery("/in")).toBe("in");
    expect(slashAutocompleteQuery("/")).toBe("");
    expect(slashAutocompleteQuery("/init extra")).toBeNull();
    expect(slashAutocompleteQuery("please /init")).toBeNull();
    expect(
      filterListedCommands("in", [{ name: "init" }, { name: "review" }]).map(
        (item) => item.name,
      ),
    ).toEqual(["init"]);
  });

  it("inserts or replaces a leading slash token", () => {
    expect(insertCommandToken("", "init")).toBe("/init ");
    expect(insertCommandToken("/in", "init")).toBe("/init ");
    expect(insertCommandToken("hello", "review")).toBe("hello /review ");
  });

  it("treats attachments as blocking the command path", () => {
    expect(hasNonTextParts([{ type: "text" }, { type: "localFile" }])).toBe(
      true,
    );
  });
});

describe("skill appendix", () => {
  it("formats configured BB skills (ISC-85)", () => {
    const text = formatSkillAppendix([
      {
        path: "/tmp/skills",
        skills: [{ name: "bb-cli", description: "Use the bb CLI" }],
      },
    ]);
    expect(text).toContain("BB skills available");
    expect(text).toContain("bb-cli: Use the bb CLI (/tmp/skills)");
  });

  it("returns null when no named skills (ISC-86)", () => {
    expect(formatSkillAppendix([])).toBeNull();
    expect(formatSkillAppendix([{ skills: [] }])).toBeNull();
  });
});
