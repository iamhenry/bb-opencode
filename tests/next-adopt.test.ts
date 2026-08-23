import { describe, expect, it } from "vitest";
import {
  NEXT_ADOPT_TTL_MS,
  armNextAdopt,
  consumeNextAdopt,
  createNextAdoptStore,
  disarmNextAdopt,
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

  it("queues two adopts for the same project", () => {
    const store = createNextAdoptStore();
    armNextAdopt(store, {
      projectId: "p",
      hostId: "h",
      opencodeSessionId: "s1",
      bindOnly: true,
    });
    armNextAdopt(store, {
      projectId: "p",
      hostId: "h",
      opencodeSessionId: "s2",
    });
    expect(
      consumeNextAdopt(store, { projectId: "p", isNewThread: true }),
    ).toMatchObject({ opencodeSessionId: "s1", bindOnly: true });
    expect(
      consumeNextAdopt(store, { projectId: "p", isNewThread: true })
        ?.opencodeSessionId,
    ).toBe("s2");
  });

  it("disarms one queued adopt without touching the next", () => {
    const store = createNextAdoptStore();
    armNextAdopt(store, {
      projectId: "p",
      hostId: "h",
      opencodeSessionId: "s1",
    });
    armNextAdopt(store, {
      projectId: "p",
      hostId: "h",
      opencodeSessionId: "s2",
    });
    disarmNextAdopt(store, { projectId: "p", opencodeSessionId: "s1" });
    expect(
      consumeNextAdopt(store, { projectId: "p", isNewThread: true })
        ?.opencodeSessionId,
    ).toBe("s2");
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
