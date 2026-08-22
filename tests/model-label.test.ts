import { describe, expect, it } from "vitest";
import { formatModelDisplayName } from "../src/model-label.js";

describe("model display labels", () => {
  it("prefixes the LLM provider so duplicate names stay distinct", () => {
    expect(formatModelDisplayName("hpc-ai", "DeepSeek V4 Flash")).toBe(
      "hpc-ai/DeepSeek V4 Flash",
    );
    expect(formatModelDisplayName("anthropic", "DeepSeek V4 Flash")).toBe(
      "anthropic/DeepSeek V4 Flash",
    );
    expect(formatModelDisplayName("hpc-ai", "hpc-ai/kimi")).toBe("hpc-ai/kimi");
  });
});
