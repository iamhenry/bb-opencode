import { describe, expect, it } from "vitest";
import { directoryQuery } from "../src/client.js";

describe("directoryQuery", () => {
  it("encodes a bound project directory", () => {
    expect(directoryQuery("/Users/macvm/Desktop/Projects/other/bb-plugin-opencode")).toBe(
      "?directory=%2FUsers%2Fmacvm%2FDesktop%2FProjects%2Fother%2Fbb-plugin-opencode",
    );
  });

  it("omits the query when no directory is bound", () => {
    expect(directoryQuery()).toBe("");
    expect(directoryQuery("")).toBe("");
  });
});
