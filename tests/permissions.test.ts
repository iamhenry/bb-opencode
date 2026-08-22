import { describe, expect, it } from "vitest";
import {
  decisionToReply,
  mapPermissionAsk,
  shouldAutoApprove,
} from "../src/permissions/map.js";

describe("permission map", () => {
  it("maps bash asks to command subjects", () => {
    const mapped = mapPermissionAsk({
      id: "p1",
      sessionID: "s1",
      permission: "bash",
      metadata: { command: "ls" },
    });
    expect(mapped.tag).toBe("ok");
    expect(mapped.subject).toMatchObject({ kind: "command", command: "ls" });
  });

  it("tags malformed asks unknown and never auto-approves (ISC-37, ISC-64)", () => {
    const mapped = mapPermissionAsk({ permission: "bash" });
    expect(mapped.tag).toBe("unknown");
    expect(
      shouldAutoApprove({ tag: mapped.tag, permissionMode: "full" }),
    ).toBe(false);
  });

  it("auto-approves only ok asks under full", () => {
    expect(
      shouldAutoApprove({ tag: "ok", permissionMode: "full" }),
    ).toBe(true);
    expect(
      shouldAutoApprove({ tag: "ok", permissionMode: "accept-edits" }),
    ).toBe(false);
  });

  it("writes card decisions back as OpenCode replies", () => {
    expect(decisionToReply("allow_once")).toBe("once");
    expect(decisionToReply("allow_for_session")).toBe("always");
    expect(decisionToReply("deny")).toBe("reject");
  });
});
