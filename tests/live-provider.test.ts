import { describe, expect, it } from "vitest";
import {
  chipSuggestsOpencode,
  composerLayoutIsCompact,
  composerSurfaceWantsBanner,
  newThreadAgentPickerVisible,
  newThreadShowsOpencodeAgent,
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

  it("does not treat native ACP OpenCode as this plugin (ISC-8)", () => {
    expect(
      providerIdFromModelTriggerTitle(
        "opencode: OpenCode Go/GLM-5.3 · High reasoning",
      ),
    ).toBe("acp-opencode");
    expect(
      chipSuggestsOpencode({
        liveProviderId: providerIdFromModelTriggerTitle(
          "opencode: OpenCode Go/GLM-5.3 · High reasoning",
        ),
      }),
    ).toBe(false);
    expect(chipSuggestsOpencode({ liveProviderId: "opencode" })).toBe(true);
    expect(composerLayoutIsCompact(null)).toBe(false);
    expect(chipSuggestsOpencode({ liveProviderId: "Pi" })).toBe(false);
  });

  it("puts the agent chip on the banner for compact/coarse surfaces", () => {
    expect(composerSurfaceWantsBanner({ layout: "compact" })).toBe(true);
    expect(composerSurfaceWantsBanner({ layout: "expanded" })).toBe(false);
    expect(newThreadShowsOpencodeAgent(null)).toBe(false);
    expect(
      newThreadAgentPickerVisible({
        liveFound: false,
        liveOpenCode: false,
        chromeOpenCode: true,
      }),
    ).toBe(true);
    expect(
      newThreadAgentPickerVisible({
        liveFound: true,
        liveOpenCode: false,
        chromeOpenCode: true,
      }),
    ).toBe(false);
    expect(
      newThreadAgentPickerVisible({
        liveFound: true,
        liveOpenCode: true,
        chromeOpenCode: false,
      }),
    ).toBe(true);
  });
});
