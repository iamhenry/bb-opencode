import { describe, expect, it } from "vitest";
import {
  consumeOpenIntent,
  pendingAdoptStorageKey,
} from "../src/pending-adopt.js";

describe("pending adopt keys", () => {
  it("keys reservations by project, host, and session (ISC-59, ISC-60)", () => {
    expect(
      pendingAdoptStorageKey({
        projectId: "p",
        hostId: "h",
        opencodeSessionId: "s",
      }),
    ).toBe("pending-adopt:p:h:s");
    expect(
      consumeOpenIntent({
        intent: {
          projectId: "p",
          hostId: "h",
          opencodeSessionId: "s",
          createdAt: 1,
        },
        projectId: "p",
        hostId: "other",
      }),
    ).toBeUndefined();
    expect(
      consumeOpenIntent({
        intent: {
          projectId: "p",
          hostId: "h",
          opencodeSessionId: "s",
          createdAt: 1,
        },
        projectId: "p",
        hostId: "h",
      }),
    ).toBe("s");
  });
});
