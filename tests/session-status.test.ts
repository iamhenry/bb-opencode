import { describe, expect, it } from "vitest";
import {
  bashCommandCwd,
  bashCommandOutput,
  describeSessionError,
  readSessionStatus,
  retryFromPart,
  retryKey,
} from "../src/session-status.js";

describe("session status", () => {
  it("reads nested and bare status payloads", () => {
    expect(readSessionStatus({ status: { type: "retry", attempt: 2, message: "429" } })).toEqual({
      kind: "retry",
      attempt: 2,
      message: "429",
    });
    expect(readSessionStatus({ status: "idle" })).toEqual({ kind: "idle" });
    expect(readSessionStatus({ type: "busy" })).toEqual({ kind: "busy" });
  });

  it("extracts retry parts and session errors", () => {
    expect(
      retryFromPart({
        type: "retry",
        attempt: 1,
        messageID: "msg_1",
        error: { name: "APIError", data: { message: "rate limited", isRetryable: true } },
      }),
    ).toEqual({
      attempt: 1,
      messageId: "msg_1",
      message: "rate limited",
    });
    expect(retryKey({ sessionId: "ses", messageId: "msg_1", attempt: 1 })).toBe(
      "ses:msg_1:1",
    );
    expect(describeSessionError({ name: "MessageAbortedError", data: { message: "aborted" } })).toEqual({
      status: "interrupted",
      message: "aborted",
    });
    expect(
      describeSessionError({
        name: "ProviderAuthError",
        data: { providerID: "openai", message: "expired" },
      }).message,
    ).toContain("openai");
    expect(describeSessionError({ name: "MessageOutputLengthError", data: {} }).message).toContain(
      "output length",
    );
  });

  it("reads bash stdout without inventing text", () => {
    expect(
      bashCommandOutput({
        metadata: { stdout: "compiling…\n" },
      }),
    ).toBe("compiling…\n");
    expect(bashCommandOutput({ output: "done" })).toBe("done");
    expect(bashCommandOutput({ metadata: {} })).toBe("");
    expect(bashCommandCwd({ workdir: "/tmp/app" })).toBe("/tmp/app");
  });
});
