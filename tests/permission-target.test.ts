import { describe, expect, it } from "vitest";
import { resolvePermissionAttach } from "../src/permissions/target.js";

describe("permission attach (ISC-74)", () => {
  it("attaches a child ask to the in-flight parent thread", () => {
    expect(
      resolvePermissionAttach({
        askSessionId: "ses_child",
        boundThreadId: null,
        parentSessionId: "ses_parent",
        parentThreadId: "thr_parent",
        parentInFlight: true,
      }),
    ).toEqual({ action: "attach", threadId: "thr_parent" });
  });

  it("drops an ask with no resolvable session", () => {
    expect(
      resolvePermissionAttach({
        askSessionId: "ses_unknown",
        boundThreadId: null,
        parentSessionId: null,
        parentThreadId: null,
        parentInFlight: false,
      }),
    ).toMatchObject({ action: "drop" });
  });

  it("drops a child ask after the parent turn has ended", () => {
    expect(
      resolvePermissionAttach({
        askSessionId: "ses_child",
        boundThreadId: null,
        parentSessionId: "ses_parent",
        parentThreadId: "thr_parent",
        parentInFlight: false,
      }),
    ).toMatchObject({ action: "drop" });
  });
});
