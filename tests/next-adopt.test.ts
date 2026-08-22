import { describe, expect, it } from "vitest";
import {
  NEXT_ADOPT_TTL_MS,
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
    expect(
      consumeNextAdopt(store, { projectId: "p", isNewThread: true })
        ?.opencodeSessionId,
    ).toBe("s");
    expect(
      consumeNextAdopt(store, { projectId: "p", isNewThread: true }),
    ).toBeUndefined();
  });

  it("does not let an unrelated project consume it (ISC-60)", () => {
    const store = createNextAdoptStore();
    armNextAdopt(store, {
      projectId: "p",
      hostId: "h",
      opencodeSessionId: "s",
    });
    expect(
      consumeNextAdopt(store, { projectId: "other", isNewThread: true }),
    ).toBeUndefined();
    expect(peekNextAdopt(store, "p")?.opencodeSessionId).toBe("s");
  });

  it("does not let a later turn on an existing thread consume it (ISC-60)", () => {
    const store = createNextAdoptStore();
    armNextAdopt(store, {
      projectId: "p",
      hostId: "h",
      opencodeSessionId: "s",
    });
    expect(
      consumeNextAdopt(store, { projectId: "p", isNewThread: false }),
    ).toBeUndefined();
    expect(peekNextAdopt(store, "p")?.opencodeSessionId).toBe("s");
  });

  it("expires an abandoned handoff", () => {
    const store = createNextAdoptStore();
    const now = 1_000;
    armNextAdopt(
      store,
      { projectId: "p", hostId: "h", opencodeSessionId: "s" },
      now,
    );
    expect(
      consumeNextAdopt(store, {
        projectId: "p",
        isNewThread: true,
        now: now + NEXT_ADOPT_TTL_MS + 1,
      }),
    ).toBeUndefined();
    expect(peekNextAdopt(store, "p")).toBeUndefined();
  });
});
