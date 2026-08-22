import { describe, expect, it } from "vitest";
import {
  chipSuggestsOpencode,
  providerIdFromModelTriggerTitle,
} from "../src/app/live-provider.js";

describe("live composer provider from model chip", () => {
  it("treats an OpenCode chip as opencode", () => {
    expect(
      providerIdFromModelTriggerTitle(
        "OpenCode: DeepSeek V4 Flash · Medium reasoning",
      ),
    ).toBe("opencode");
    expect(providerIdFromModelTriggerTitle("OpenCode")).toBe("opencode");
  });

  it("does not treat other providers as opencode", () => {
    expect(
      providerIdFromModelTriggerTitle("Pi: Opus 5 1M · Medium reasoning"),
    ).not.toBe("opencode");
    expect(
      providerIdFromModelTriggerTitle(
        "Claude Code: Sonnet 4.6 · Medium reasoning",
      ),
    ).not.toBe("opencode");
    expect(providerIdFromModelTriggerTitle(null)).toBeNull();
  });

  it("treats the OpenCode logo or title as selected", () => {
    expect(
      chipSuggestsOpencode({
        hasOpencodeLogo: true,
        text: "DeepSeek V4 Flash Medium",
      }),
    ).toBe(true);
    expect(
      chipSuggestsOpencode({
        hasOpencodeLogo: false,
        text: "Opus 5 1M Medium",
        title: "Pi: Opus 5 1M · Medium reasoning",
      }),
    ).toBe(false);
  });
});
