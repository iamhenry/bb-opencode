import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireClient,
  createSdkClient,
  type OpenCodeClient,
} from "../src/client.js";

const openCodeMake = vi.hoisted(() => vi.fn());

vi.mock("@opencode/client", () => ({
  OpenCode: { make: openCodeMake },
}));

function stub(url: string): OpenCodeClient {
  return { url } as OpenCodeClient;
}

describe("acquireClient", () => {
  beforeEach(() => {
    openCodeMake.mockReset();
  });

  it("keys clients by attach URL and recreates after eviction (ISC-67)", () => {
    const cache = new Map<string, OpenCodeClient>();
    let created = 0;
    const factory = (url: string) => {
      created += 1;
      return stub(url);
    };
    const a = acquireClient(factory, cache, "http://127.0.0.1:1");
    const a2 = acquireClient(factory, cache, "http://127.0.0.1:1");
    const b = acquireClient(factory, cache, "http://127.0.0.1:2");
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(created).toBe(2);
    cache.delete("http://127.0.0.1:1");
    acquireClient(factory, cache, "http://127.0.0.1:1");
    expect(created).toBe(3);
  });

  it("warms a cold workspace before accepting an empty model catalog", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    let modelReads = 0;
    openCodeMake.mockReturnValue({
      provider: {
        async list(input: unknown) {
          calls.push({ method: "provider", input });
          return { data: [{ id: "openai", name: "OpenAI" }] };
        },
      },
      model: {
        async list(input: unknown) {
          calls.push({ method: "model", input });
          modelReads += 1;
          return modelReads === 1
            ? { data: [] }
            : {
                data: [
                  {
                    id: "gpt-test",
                    providerID: "openai",
                    enabled: true,
                  },
                ],
              };
        },
      },
    });

    const result = await createSdkClient("http://127.0.0.1:9").providers(
      "/tmp/cold-workspace",
    );

    expect(calls).toEqual([
      {
        method: "provider",
        input: { location: { directory: "/tmp/cold-workspace" } },
      },
      {
        method: "model",
        input: { location: { directory: "/tmp/cold-workspace" } },
      },
      {
        method: "model",
        input: { location: { directory: "/tmp/cold-workspace" } },
      },
    ]);
    expect(result.providers).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-test": {
            id: "gpt-test",
            providerID: "openai",
            enabled: true,
          },
        },
      },
    ]);
  });
});
