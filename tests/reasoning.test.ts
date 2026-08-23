import { describe, expect, it } from "vitest";
import {
  defaultReasoningEffortFor,
  openCodeVariantFor,
  reasoningLevelOf,
  supportedReasoningEffortsForModel,
  variantKeysFromModel,
} from "../src/reasoning.js";

describe("reasoning", () => {
  it("maps BB reasoning levels onto OpenCode variants", () => {
    expect(openCodeVariantFor("low")).toBe("low");
    expect(openCodeVariantFor("medium")).toBe("medium");
    expect(openCodeVariantFor("high")).toBe("high");
    expect(openCodeVariantFor("xhigh")).toBe("xhigh");
    expect(openCodeVariantFor("max")).toBe("max");
    expect(openCodeVariantFor("none")).toBeUndefined();
    expect(openCodeVariantFor("ultracode", ["high", "max"])).toBe("max");
    expect(openCodeVariantFor("xhigh", ["low", "medium", "high"])).toBeUndefined();
  });

  it("reads reasoningLevel from execution options", () => {
    expect(reasoningLevelOf({ reasoningLevel: "high" })).toBe("high");
    expect(reasoningLevelOf({})).toBeUndefined();
  });

  it("advertises each model's OpenCode variants as BB reasoning efforts", () => {
    expect(
      supportedReasoningEffortsForModel({
        variants: {
          none: {},
          low: {},
          medium: {},
          high: {},
          xhigh: {},
          max: {},
        },
      }).map((effort) => effort.reasoningEffort),
    ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);

    expect(
      supportedReasoningEffortsForModel({
        variants: {
          high: { thinking: { type: "enabled" } },
          max: { thinking: { type: "enabled" } },
        },
      }).map((effort) => effort.reasoningEffort),
    ).toEqual(["high", "max"]);

    expect(
      supportedReasoningEffortsForModel({
        variants: {
          minimal: {},
          low: {},
          high: {},
        },
      }).map((effort) => effort.reasoningEffort),
    ).toEqual(["low", "high"]);
  });

  it("falls back to none when OpenCode lists no BB-legal variants", () => {
    expect(supportedReasoningEffortsForModel({ variants: {} })).toEqual([
      { reasoningEffort: "none", description: "No extended thinking" },
    ]);
    expect(
      supportedReasoningEffortsForModel({
        capabilities: { reasoning: true },
        variants: { minimal: {} },
      }),
    ).toEqual([{ reasoningEffort: "none", description: "No extended thinking" }]);
  });

  it("reads v2 variant arrays", () => {
    expect(
      variantKeysFromModel({
        variants: [{ id: "low" }, { id: "high" }],
      }),
    ).toEqual(["low", "high"]);
  });

  it("defaults to medium when the model has it", () => {
    expect(
      defaultReasoningEffortFor(
        supportedReasoningEffortsForModel({
          variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
        }),
      ),
    ).toBe("medium");
    expect(
      defaultReasoningEffortFor(
        supportedReasoningEffortsForModel({
          variants: { high: {}, max: {} },
        }),
      ),
    ).toBe("high");
  });
});
