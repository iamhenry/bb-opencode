import { describe, expect, it } from "vitest";
import { unwrapPluginRpcResult } from "../src/app/rpc.js";

describe("unwrapPluginRpcResult", () => {
  it("unwraps BB {ok, result} envelopes", () => {
    expect(
      unwrapPluginRpcResult<{ providerId: string }>(
        { ok: true, result: { providerId: "opencode" } },
        "threadProvider",
      ),
    ).toEqual({ providerId: "opencode" });
  });

  it("throws the server error string", () => {
    expect(() =>
      unwrapPluginRpcResult(
        { ok: false, error: "Thread is not bound to an OpenCode session" },
        "undo",
      ),
    ).toThrow("Thread is not bound to an OpenCode session");
  });
});
