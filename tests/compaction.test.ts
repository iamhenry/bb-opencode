import { describe, expect, it } from "vitest";
import {
  isCompactRequest,
  isCompactionSkipError,
  isOpenCodeCompactCommand,
} from "../src/compaction.js";

describe("compact request detection", () => {
  it("treats BB builtin /compact as a compact request (ISC-92)", () => {
    expect(
      isCompactRequest([
        {
          type: "text",
          text: "/compact",
          mentions: [
            {
              start: 0,
              end: 8,
              resource: {
                kind: "command",
                name: "compact",
                origin: "builtin",
              },
            },
          ],
        },
      ]),
    ).toBe(true);
  });

  it("treats standalone /compact and /summarize text as compact", () => {
    expect(isCompactRequest([{ type: "text", text: "/compact" }])).toBe(true);
    expect(isCompactRequest([{ type: "text", text: "  /summarize  " }])).toBe(
      true,
    );
    expect(isCompactRequest([{ type: "text", text: "/compact extra" }])).toBe(
      false,
    );
    expect(isCompactRequest([{ type: "text", text: "please compact" }])).toBe(
      false,
    );
  });

  it("does not treat attachments as compact", () => {
    expect(
      isCompactRequest([
        { type: "text", text: "/compact" },
        { type: "localFile", text: "" },
      ]),
    ).toBe(false);
  });

  it("names OpenCode compact commands so they stay off the slash list", () => {
    expect(isOpenCodeCompactCommand("compact")).toBe(true);
    expect(isOpenCodeCompactCommand("Summarize")).toBe(true);
    expect(isOpenCodeCompactCommand("init")).toBe(false);
  });

  it("recognizes OpenCode skip errors as no-ops", () => {
    expect(
      isCompactionSkipError("Nothing to compact (session too small)"),
    ).toBe(true);
    expect(isCompactionSkipError("Already compacted")).toBe(true);
    expect(isCompactionSkipError("network down")).toBe(false);
  });
});
