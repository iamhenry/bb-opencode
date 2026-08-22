import { describe, expect, it } from "vitest";
import {
  armNextAdopt,
  consumeNextAdopt,
  createNextAdoptStore,
  peekNextAdopt,
} from "../src/next-adopt.js";

describe("next adopt", () => {
  it("consumes a pending adopt once (ISC-59)", () => {
    const store = createNextAdoptStore();
    armNextAdopt(store, {
      projectId: "p",
      hostId: "h",
      opencodeSessionId: "s",
    });
    expect(consumeNextAdopt(store, "p")?.opencodeSessionId).toBe("s");
    expect(consumeNextAdopt(store, "p")).toBeUndefined();
  });

  it("does not let an unrelated project consume it (ISC-60)", () => {
    const store = createNextAdoptStore();
    armNextAdopt(store, {
      projectId: "p",
      hostId: "h",
      opencodeSessionId: "s",
    });
    expect(consumeNextAdopt(store, "other")).toBeUndefined();
    expect(peekNextAdopt(store, "p")?.opencodeSessionId).toBe("s");
  });
});
