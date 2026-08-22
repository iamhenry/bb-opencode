import { describe, expect, it } from "vitest";
import { shouldRenderOpencodeChrome } from "../src/app/visibility.js";

describe("opencode chrome visibility", () => {
  it("hides composer and header chrome for other providers (ISC-8.1, ISC-8.2)", () => {
    expect(shouldRenderOpencodeChrome("claude-code")).toBe(false);
    expect(shouldRenderOpencodeChrome("acp-opencode")).toBe(false);
    expect(shouldRenderOpencodeChrome(null)).toBe(false);
    expect(shouldRenderOpencodeChrome("opencode")).toBe(true);
  });
});
