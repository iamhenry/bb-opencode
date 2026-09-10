import { describe, expect, it } from "vitest";
import {
  compareVersionStrings,
  isVersionInWindow,
  versionSkewMessage,
} from "../src/identity.js";

describe("version window", () => {
  it("accepts the pinned 1.18.x range", () => {
    expect(isVersionInWindow("1.18.0")).toBe(true);
    expect(isVersionInWindow("1.18.21")).toBe(true);
    expect(isVersionInWindow("1.19.0")).toBe(false);
    expect(isVersionInWindow("1.17.9")).toBe(false);
    expect(isVersionInWindow("1.18.21-beta")).toBe(false);
    expect(isVersionInWindow("1.18.21foo")).toBe(false);
    expect(isVersionInWindow("v1.18.21")).toBe(true);
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
    expect(message).toContain("1.18.0");
    expect(message).toContain("1.19.0");
  });
});
