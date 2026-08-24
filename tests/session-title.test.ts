import { describe, expect, it } from "vitest";
import {
  fallbackSessionTitle,
  firstVisibleUserText,
  isDefaultOpenCodeTitle,
  persistPublishedOpenCodeTitle,
  publishedTitleFromThreadEvents,
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

  it("recovers a greeting title instead of the raw first message", () => {
    expect(fallbackSessionTitle("What's good")).toBe("Casual greeting");
    expect(fallbackSessionTitle("good morning")).toBe("Casual greeting");
    expect(fallbackSessionTitle("Sup")).toBe("Casual greeting");
    expect(
      fallbackSessionTitle("Create a file scratch/isc33-probe.txt containing exactly ISC33_OK"),
    ).toBe("Create a file scratch/isc33-probe.txt containing exactly");
  });

  it("reads the visible user text, not BB instruction parts", () => {
    expect(
      firstVisibleUserText([
        {
          info: { role: "user" },
          parts: [
            { type: "text", text: "[BB project instructions]\nYou are working inside bb" },
            { type: "text", text: "What's good" },
          ],
        },
      ]),
    ).toBe("What's good");
  });

  it("reads the latest publishable thread.name event", () => {
    expect(
      publishedTitleFromThreadEvents([
        {
          type: "thread/name/updated",
          data: { threadName: "Morning greeting" },
        },
        {
          type: "thread/name/updated",
          data: { threadName: "New session - 2026-08-23T15:22:24.150Z" },
        },
      ]),
    ).toBe("Morning greeting");
  });

  it("persists a published OpenCode title onto an untitled BB thread", async () => {
    let updated: string | null = null;
    await expect(
      persistPublishedOpenCodeTitle({
        providerId: "opencode",
        title: null,
        listEvents: async () => [
          {
            type: "thread/name/updated",
            data: { threadName: "Morning greeting" },
          },
        ],
        updateTitle: async (title) => {
          updated = title;
        },
      }),
    ).resolves.toBe(true);
    expect(updated).toBe("Morning greeting");
  });

  it("does not overwrite an existing BB title", async () => {
    let updated: string | null = null;
    await expect(
      persistPublishedOpenCodeTitle({
        providerId: "opencode",
        title: "User title",
        listEvents: async () => {
          throw new Error("should not list");
        },
        updateTitle: async (title) => {
          updated = title;
        },
      }),
    ).resolves.toBe(false);
    expect(updated).toBeNull();
  });
});
