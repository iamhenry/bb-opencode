import { describe, expect, it } from "vitest";
import {
  coerceModelRef,
  configDefaultModelId,
  lastModelIdFromMessages,
  listAuthenticatedProviders,
} from "../src/catalog.js";

describe("authenticated OpenCode catalog", () => {
  it("uses config.providers when present", () => {
    const listed = listAuthenticatedProviders({
      providers: [{ id: "anthropic", models: { opus: { name: "Opus" } } }],
      all: [{ id: "abacus", models: {} }],
    });
    expect(listed.map((provider) => provider.id)).toEqual(["anthropic"]);
  });

  it("filters GET /provider all by connected ids", () => {
    const listed = listAuthenticatedProviders({
      connected: ["anthropic", "opencode"],
      all: [
        { id: "abacus", models: {} },
        { id: "anthropic", models: {} },
        { id: "opencode", models: {} },
        { id: "minimax", models: {} },
      ],
    });
    expect(listed.map((provider) => provider.id)).toEqual([
      "anthropic",
      "opencode",
    ]);
  });

  it("does not dump the unauthenticated catalog", () => {
    expect(
      listAuthenticatedProviders({
        all: [{ id: "abacus" }, { id: "minimax" }],
      }),
    ).toEqual([]);
  });

  it("reads OpenCode config default as provider/model", () => {
    expect(configDefaultModelId({ model: "opencode/gpt-4.1" })).toBe(
      "opencode/gpt-4.1",
    );
    expect(
      configDefaultModelId({
        model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      }),
    ).toBe("anthropic/claude-sonnet-4");
  });

  it("coerces BB bare model ids onto provider/model", () => {
    expect(coerceModelRef("openai/gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
    expect(
      coerceModelRef("gpt-5.6-luna", {
        lastPrompted: "openai/gpt-5.6-luna",
      }),
    ).toBe("openai/gpt-5.6-luna");
    expect(
      coerceModelRef("gpt-5.6-luna", {
        providers: [
          { id: "anthropic", models: { "claude-sonnet-4": {} } },
          { id: "openai", models: { "gpt-5.6-luna": {}, "gpt-5.6-sol": {} } },
        ],
      }),
    ).toBe("openai/gpt-5.6-luna");
    expect(coerceModelRef("gpt-5.6-luna")).toBeUndefined();
  });

  it("reads the last prompted model from session messages", () => {
    expect(
      lastModelIdFromMessages([
        {
          info: {
            role: "user",
            model: { providerID: "xai", modelID: "grok-4.6" },
          },
        },
        {
          info: {
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-5.6-sol",
          },
        },
      ]),
    ).toBe("openai/gpt-5.6-sol");
  });
});
