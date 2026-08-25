import { describe, expect, it } from "vitest";
import {
  decisionToReply,
  isPermissionAskEvent,
  mapPermissionAsk,
  shouldAutoApprove,
  shouldShowCard,
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

  it("defers a bash ask until the command string arrives", () => {
    const mapped = mapPermissionAsk({
      id: "p1",
      sessionID: "s1",
      permission: "bash",
    });
    expect(mapped.tag).toBe("deferred");
    expect(
      shouldAutoApprove({ tag: mapped.tag, permissionMode: "full" }),
    ).toBe(false);
    expect(
      mapPermissionAsk({
        id: "p1",
        sessionID: "s1",
        type: "bash",
        pattern: "*",
      }).tag,
    ).toBe("deferred");
  });

  it("auto-approves only ok asks under full", () => {
    expect(
      shouldAutoApprove({ tag: "ok", permissionMode: "full" }),
    ).toBe(true);
    expect(
      shouldAutoApprove({ tag: "ok", permissionMode: "accept-edits" }),
    ).toBe(false);
  });

  it("shows a card unless the live mode is full", () => {
    expect(shouldShowCard({ tag: "ok", permissionMode: "auto" })).toBe(true);
    expect(shouldShowCard({ tag: "ok", permissionMode: "accept-edits" })).toBe(
      true,
    );
    expect(shouldShowCard({ tag: "ok", permissionMode: "full" })).toBe(false);
    expect(shouldShowCard({ tag: "unknown", permissionMode: "auto" })).toBe(
      false,
    );
  });

  it("maps 1.18 permission.updated bash asks (type/pattern/callID)", () => {
    const mapped = mapPermissionAsk({
      id: "p1",
      sessionID: "s1",
      type: "bash",
      pattern: "echo *",
      callID: "call_1",
      metadata: { command: "echo hi" },
    });
    expect(mapped.tag).toBe("ok");
    expect(mapped.subject).toMatchObject({
      kind: "command",
      command: "echo hi",
      itemId: "call_1",
    });
    expect(isPermissionAskEvent("permission.updated")).toBe(true);
    expect(isPermissionAskEvent("permission.asked")).toBe(true);
    expect(isPermissionAskEvent("permission.v2.asked")).toBe(true);
  });

  it("maps 1.18 permission.v2.asked edit asks (action/resources/source)", () => {
    const mapped = mapPermissionAsk({
      id: "per_1",
      sessionID: "ses_1",
      action: "edit",
      resources: ["scratch/isc33-probe.txt"],
      source: { type: "tool", messageID: "msg_1", callID: "call_v2" },
    });
    expect(mapped.tag).toBe("ok");
    expect(mapped.permission).toBe("edit");
    expect(mapped.subject).toMatchObject({
      kind: "file_change",
      itemId: "call_v2",
      writeScope: "scratch/isc33-probe.txt",
    });
  });

  it("unwraps durable data envelopes", () => {
    const mapped = mapPermissionAsk({
      type: "permission.v2.asked",
      data: {
        id: "per_2",
        sessionID: "ses_1",
        action: "apply_patch",
        resources: ["scratch/isc33-probe.txt"],
      },
    });
    expect(mapped.tag).toBe("ok");
    expect(mapped.subject).toMatchObject({
      kind: "file_change",
      writeScope: "scratch/isc33-probe.txt",
    });
  });

  it("writes card decisions back as OpenCode replies", () => {
    expect(decisionToReply("allow_once")).toBe("once");
    expect(decisionToReply("allow_for_session")).toBe("always");
    expect(decisionToReply("deny")).toBe("reject");
  });
});
