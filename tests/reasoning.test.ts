import { describe, expect, it } from "vitest";
import { openCodeVariantFor, reasoningLevelOf } from "../src/reasoning.js";

describe("reasoning", () => {
  it("maps BB reasoning levels onto OpenCode variants", () => {
    expect(openCodeVariantFor("low")).toBe("low");
    expect(openCodeVariantFor("medium")).toBe("medium");
    expect(openCodeVariantFor("high")).toBe("high");
    expect(openCodeVariantFor("max")).toBe("max");
    expect(openCodeVariantFor("none")).toBeUndefined();
  });

  it("reads reasoningLevel from execution options", () => {
    expect(reasoningLevelOf({ reasoningLevel: "high" })).toBe("high");
    expect(reasoningLevelOf({})).toBeUndefined();
  });
});
