import { describe, expect, it } from "vitest";
import {
  isWebFetchToolName,
  isWebSearchToolName,
  webFetchItem,
  webSearchItem,
} from "../src/web-items.js";

describe("web items", () => {
  it("maps webfetch/websearch tools", () => {
    expect(isWebSearchToolName("websearch")).toBe(true);
    expect(isWebFetchToolName("webfetch")).toBe(true);
    expect(webSearchItem({ query: "bb plugins" })).toEqual({
      type: "webSearch",
      queries: ["bb plugins"],
    });
    expect(webFetchItem({ url: "https://example.com" })).toEqual({
      type: "webFetch",
      url: "https://example.com",
      prompt: null,
      pattern: null,
    });
  });
});
