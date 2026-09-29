import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fake: undefined as unknown }));

vi.mock("../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client.js")>();
  return {
    ...actual,
    createSdkClient: () => (mocks.fake as { client: unknown }).client as never,
  };
});

vi.mock("../src/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process.js")>();
  return {
    ...actual,
    attachOrSpawn: async () => ({
      url: "http://fake-opencode",
      pid: 1,
      port: 9,
      spawned: false,
    }),
  };
});

import {
  evictClientsForTests,
  handleRevert,
  handleRevertCommit,
  handleUnrevert,
} from "../src/host-handlers.js";
import { createFakeOpenCode, type FakeOpenCode } from "./fake-opencode.js";

const parentId = "ses_parent";
const targetId = "parent-target";

function message(id: string, role: string, created: number) {
  return { info: { id, role, time: { created } }, parts: [] };
}

function addSession(
  fake: FakeOpenCode,
  id: string,
  created: number,
  messages: ReturnType<typeof message>[],
  options: { parentID?: string; revert?: string } = {},
) {
  fake.sessions.set(id, {
    id,
    time: { created },
    ...(options.parentID ? { parentID: options.parentID } : {}),
    ...(options.revert ? { revert: { messageID: options.revert } } : {}),
  });
  fake.messages.set(id, messages);
}

function addParent(fake: FakeOpenCode) {
  addSession(fake, parentId, 100, [message("earlier", "user", 150), message(targetId, "user", 200)]);
}

describe("host revert cascade ownership", () => {
  let fake: FakeOpenCode;

  beforeEach(() => {
    fake = createFakeOpenCode();
    mocks.fake = fake;
    evictClientsForTests();
  });

  it("leaves an unrelated pre-staged descendant untouched through stage, restore, and commit", async () => {
    addParent(fake);
    addSession(
      fake,
      "ses_owned",
      250,
      [message("owned-first", "user", 251)],
      { parentID: parentId },
    );
    addSession(
      fake,
      "ses_unrelated",
      150,
      [message("unrelated-first", "user", 151)],
      { parentID: parentId, revert: "unrelated-first" },
    );

    expect(
      await handleRevert("/unused", parentId, { messageID: targetId, role: "user" }),
    ).toMatchObject({ ok: true });
    expect(fake.calls.revertTargets).toEqual([
      { id: "ses_owned", messageID: "owned-first" },
      { id: parentId, messageID: targetId },
    ]);
    expect(fake.sessions.get("ses_unrelated")?.revert).toEqual({ messageID: "unrelated-first" });

    addSession(
      fake,
      "ses_other_staged",
      260,
      [message("other-first", "user", 261), message("other-second", "user", 262)],
      { parentID: parentId, revert: "other-second" },
    );
    expect(await handleUnrevert("/unused", parentId)).toMatchObject({ ok: true });
    expect(fake.calls.unrevertTargets).toEqual(["ses_owned", parentId]);
    expect(fake.sessions.get("ses_unrelated")?.revert).toEqual({ messageID: "unrelated-first" });
    expect(fake.sessions.get("ses_other_staged")?.revert).toEqual({ messageID: "other-second" });

    const otherStagedSession = fake.sessions.get("ses_other_staged");
    if (otherStagedSession) otherStagedSession.revert = undefined;
    expect(
      await handleRevert("/unused", parentId, { messageID: targetId, role: "user" }),
    ).toMatchObject({ ok: true });
    if (otherStagedSession) otherStagedSession.revert = { messageID: "other-second" };
    expect(await handleRevertCommit("/unused", parentId)).toMatchObject({ ok: true });
    expect(fake.calls.revertCommitTargets).toEqual(["ses_owned", parentId]);
    expect(fake.sessions.get("ses_unrelated")?.revert).toEqual({ messageID: "unrelated-first" });
    expect(fake.sessions.get("ses_other_staged")?.revert).toEqual({ messageID: "other-second" });
  });

  it("clears only descendants staged by this call after a later stage fails", async () => {
    addParent(fake);
    addSession(fake, "ses_staged", 250, [message("staged-first", "user", 251)], {
      parentID: parentId,
    });
    addSession(fake, "ses_fails", 260, [message("fails-first", "user", 261)], {
      parentID: parentId,
    });
    addSession(
      fake,
      "ses_unrelated",
      150,
      [message("unrelated-first", "user", 151)],
      { parentID: parentId, revert: "unrelated-first" },
    );
    fake.revertImpl = async (id) => {
      if (id === "ses_fails") throw new Error("stage failed");
    };

    expect(
      await handleRevert("/unused", parentId, { messageID: targetId, role: "user" }),
    ).toMatchObject({ ok: false, error: "stage failed" });
    expect(fake.calls.unrevertTargets).toEqual(["ses_staged"]);
    expect(fake.sessions.get("ses_staged")?.revert).toBeUndefined();
    expect(fake.sessions.get("ses_fails")?.revert).toBeUndefined();
    expect(fake.sessions.get("ses_unrelated")?.revert).toEqual({ messageID: "unrelated-first" });
  });

  it("fails closed without replacing an eligible descendant's existing staged target", async () => {
    addParent(fake);
    addSession(
      fake,
      "ses_pre_staged",
      250,
      [message("child-first", "user", 251), message("child-later", "user", 252)],
      { parentID: parentId, revert: "child-later" },
    );

    expect(
      await handleRevert("/unused", parentId, { messageID: targetId, role: "user" }),
    ).toMatchObject({ ok: false });
    expect(fake.calls.revertTargets).toEqual([]);
    expect(fake.sessions.get("ses_pre_staged")?.revert).toEqual({ messageID: "child-later" });
  });

  it.each(["absent", "duplicate", "non-user"])(
    "rejects a %s explicit target before any stage call",
    async (kind) => {
      if (kind === "absent") {
        addParent(fake);
      } else if (kind === "duplicate") {
        addSession(fake, parentId, 100, [
          message("duplicate", "user", 150),
          message("duplicate", "user", 200),
        ]);
      } else {
        addSession(fake, parentId, 100, [message("tool-output", "tool", 200)]);
      }

      const messageID =
        kind === "absent" ? "missing" : kind === "duplicate" ? "duplicate" : "tool-output";
      expect(await handleRevert("/unused", parentId, { messageID })).toMatchObject({ ok: false });
      expect(fake.calls.revert).toBe(0);
      expect(fake.calls.revertTargets).toEqual([]);
    },
  );
});
