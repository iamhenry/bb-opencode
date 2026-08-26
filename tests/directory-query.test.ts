import { describe, expect, it } from "vitest";
import { directoryQuery } from "../src/client.js";

describe("directoryQuery", () => {
  it("encodes a bound project directory", () => {
    expect(directoryQuery("/work/example/bb-plugin-opencode")).toBe(
      "?directory=%2Fwork%2Fexample%2Fbb-plugin-opencode",
    );
  });

  it("omits the query when no directory is bound", () => {
    expect(directoryQuery()).toBe("");
    expect(directoryQuery("")).toBe("");
  });
});
