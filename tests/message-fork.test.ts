import { describe, expect, it } from "vitest";
import { threadHref } from "../src/app/message-fork.js";

describe("threadHref", () => {
  it("builds the project thread path", () => {
    expect(threadHref("proj_1", "thr_2")).toBe(
      "/projects/proj_1/threads/thr_2",
    );
  });
});
