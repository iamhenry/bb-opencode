import { describe, expect, it } from "vitest";
import { sessionIdFromThreadEvents } from "../src/session-bind.js";

describe("session bind from identity events", () => {
  it("reads providerThreadId from thread/identity rows", () => {
    expect(
      sessionIdFromThreadEvents([
        { type: "item/started", data: {} },
        {
          type: "thread/identity",
          data: { providerThreadId: "ses_abc" },
        },
      ]),
    ).toBe("ses_abc");
  });

  it("returns null when identity is missing", () => {
    expect(sessionIdFromThreadEvents([])).toBeNull();
    expect(sessionIdFromThreadEvents({ events: [] })).toBeNull();
  });
});
