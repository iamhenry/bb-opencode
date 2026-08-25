import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePermissionMode,
  permissionModeFromExactLabel,
  pickVisiblePermissionMode,
} from "../src/permission-mode.js";
import {
  clearLivePermissionModes,
  readLivePermissionMode,
  writeLivePermissionMode,
} from "../src/permission-mode-live.js";

describe("permission mode labels", () => {
  it("maps footer copy to BB modes", () => {
    expect(permissionModeFromExactLabel("Full Access")).toBe("full");
    expect(permissionModeFromExactLabel("Approve for me")).toBe("auto");
    expect(permissionModeFromExactLabel("Accept Edits")).toBe("accept-edits");
    expect(permissionModeFromExactLabel("Permission mode")).toBeUndefined();
  });

  it("ignores an open menu that lists every mode", () => {
    expect(pickVisiblePermissionMode(["Full Access"])).toBe("full");
    expect(
      pickVisiblePermissionMode([
        "Accept Edits",
        "Approve for me",
        "Full Access",
      ]),
    ).toBeUndefined();
  });

  it("rejects unknown mode strings", () => {
    expect(parsePermissionMode("full")).toBe("full");
    expect(parsePermissionMode("workspace-write")).toBeUndefined();
  });
});

describe("live permission mode file", () => {
  it("round-trips a stamp and clears", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "oc-perm-"));
    writeLivePermissionMode(dataDir, "thr_1", "full");
    expect(readLivePermissionMode(dataDir, "thr_1")).toBe("full");
    clearLivePermissionModes(dataDir);
    expect(readLivePermissionMode(dataDir, "thr_1")).toBeUndefined();
  });
});
