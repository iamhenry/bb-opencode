import { describe, expect, it } from "vitest";
import {
  isDefaultOpenCodeTitle,
  shouldPublishOpenCodeTitle,
} from "../src/session-title.js";

describe("OpenCode default titles", () => {
  it("matches the official New session / Child session ISO placeholders", () => {
    expect(
      isDefaultOpenCodeTitle("New session - 2026-07-06T22:33:57.776Z"),
    ).toBe(true);
    expect(
      isDefaultOpenCodeTitle("Child session - 2026-07-06T22:33:57.776Z"),
    ).toBe(true);
    expect(shouldPublishOpenCodeTitle("New session - 2026-07-06T22:33:57.776Z")).toBe(
      false,
    );
  });

  it("publishes generated, forked, and user titles", () => {
    expect(shouldPublishOpenCodeTitle("Fix auth middleware")).toBe(true);
    expect(shouldPublishOpenCodeTitle("Fix auth middleware (fork #1)")).toBe(true);
    expect(shouldPublishOpenCodeTitle("New session notes")).toBe(true);
    expect(shouldPublishOpenCodeTitle("")).toBe(false);
  });
});
