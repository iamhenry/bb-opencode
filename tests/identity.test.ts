import { describe, expect, it } from "vitest";
import {
  compareVersionStrings,
  isVersionInWindow,
  versionSkewMessage,
} from "../src/identity.js";

describe("version window", () => {
  it("accepts the pinned 2.x range", () => {
    expect(isVersionInWindow("2.0.0")).toBe(true);
    expect(isVersionInWindow("2.0.18")).toBe(true);
    expect(isVersionInWindow("3.0.0")).toBe(false);
    expect(isVersionInWindow("1.18.33")).toBe(false);
    expect(isVersionInWindow("2.0.18-beta")).toBe(false);
    expect(isVersionInWindow("2.0.18foo")).toBe(false);
    expect(isVersionInWindow("v2.0.18")).toBe(true);
  });

  it("orders semver and rejects junk", () => {
    expect(compareVersionStrings("1.18.29", "1.18.21")).toBeGreaterThan(0);
    expect(compareVersionStrings("1.18.21", "1.18.21")).toBe(0);
    expect(compareVersionStrings("1.18.0", "1.18.21")).toBeLessThan(0);
    expect(compareVersionStrings("nope", "1.18.21")).toBeNull();
  });

  it("names both versions on skew", () => {
    const message = versionSkewMessage("1.17.0");
    expect(message).toContain("1.17.0");
    expect(message).toContain("2.0.0");
    expect(message).toContain("3.0.0");
  });
});
