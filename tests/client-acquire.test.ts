import { describe, expect, it } from "vitest";
import { acquireClient, type OpenCodeClient } from "../src/client.js";

function stub(url: string): OpenCodeClient {
  return { url } as OpenCodeClient;
}

describe("acquireClient", () => {
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
});
