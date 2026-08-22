import { describe, expect, it } from "vitest";
import { classifyImportRow } from "../src/import-row.js";

describe("import row classification", () => {
  it("blocks already imported ids (ISC-43)", () => {
    expect(
      classifyImportRow({
        id: "s",
        directory: "/tmp/a",
        running: false,
        importedIds: new Set(["s"]),
      }),
    ).toMatchObject({ blocked: true, blockReason: "already-imported" });
  });

  it("blocks running sessions (ISC-44)", () => {
    expect(
      classifyImportRow({
        id: "s",
        directory: "/tmp/a",
        running: true,
        importedIds: new Set(),
      }),
    ).toMatchObject({ blocked: true, blockReason: "running" });
  });

  it("blocks missing directories (ISC-45)", () => {
    expect(
      classifyImportRow({
        id: "s",
        directory: null,
        running: false,
        importedIds: new Set(),
      }),
    ).toMatchObject({ blocked: true, blockReason: "missing-directory" });
  });
});
