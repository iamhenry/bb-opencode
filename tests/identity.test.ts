import { describe, expect, it } from "vitest";
import {
  isVersionInWindow,
  versionSkewMessage,
} from "../src/identity.js";

describe("version window", () => {
  it("accepts the pinned 1.18.x range", () => {
    expect(isVersionInWindow("1.18.0")).toBe(true);
    expect(isVersionInWindow("1.18.21")).toBe(true);
    expect(isVersionInWindow("1.19.0")).toBe(false);
    expect(isVersionInWindow("1.17.9")).toBe(false);
  });

  it("names both versions on skew", () => {
    const message = versionSkewMessage("1.17.0");
    expect(message).toContain("1.17.0");
    expect(message).toContain("1.18.0");
    expect(message).toContain("1.19.0");
  });
});
