import { describe, expect, it } from "vitest";
import { readCompleteHistory } from "../src/history-pages.js";
import { createFakeOpenCode } from "./fake-opencode.js";

const message = (id: string) => ({
  info: { id, role: id.startsWith("u") ? "user" : "assistant" },
  parts: [{ type: "text", text: id }],
});

describe("complete history paging", () => {
  it("loads bounded pages and restores source order", async () => {
    const fake = createFakeOpenCode();
    fake.messages.set("ses_1", [
      message("u1"),
      message("a1"),
      message("a2"),
      message("a3"),
      message("a4"),
    ]);

    const result = await readCompleteHistory(fake.client, "ses_1", 2);

    expect(result.paginated).toBe(true);
    expect(result.pages).toBe(3);
    expect(result.messages.map((entry) => entry.info.id)).toEqual([
      "u1",
      "a1",
      "a2",
      "a3",
      "a4",
    ]);
    expect(fake.calls.messageReads).toEqual([
      { id: "ses_1", limit: 2, before: undefined },
      { id: "ses_1", limit: 2, before: "a3" },
      { id: "ses_1", limit: 2, before: "a1" },
    ]);
  });

  it("falls back once when an older server ignores the before cursor", async () => {
    const fake = createFakeOpenCode();
    const stored = [message("u1"), message("a1"), message("a2")];
    fake.client.sessionMessages = async (_id, limit) =>
      limit === undefined ? stored : stored.slice(-limit);

    const result = await readCompleteHistory(fake.client, "ses_1", 2);

    expect(result.paginated).toBe(false);
    expect(result.pages).toBe(3);
    expect(result.messages.map((entry) => entry.info.id)).toEqual([
      "u1",
      "a1",
      "a2",
    ]);
  });

  it("falls back once when an older server rejects the before cursor", async () => {
    const fake = createFakeOpenCode();
    const stored = [message("u1"), message("a1"), message("a2")];
    const calls: Array<{ limit?: number; before?: string }> = [];
    fake.client.sessionMessages = async (_id, limit, before) => {
      calls.push({ limit, before });
      if (before !== undefined) throw new Error("BadRequest");
      return limit === undefined ? stored : stored.slice(-limit);
    };

    const result = await readCompleteHistory(fake.client, "ses_1", 2);

    expect(result.paginated).toBe(false);
    expect(result.pages).toBe(3);
    expect(result.messages.map((entry) => entry.info.id)).toEqual([
      "u1",
      "a1",
      "a2",
    ]);
    expect(calls).toEqual([
      { limit: 2, before: undefined },
      { limit: 2, before: "a1" },
      { limit: undefined, before: undefined },
    ]);
  });
});
