import { describe, expect, it } from "vitest";
import { resolveImportEnvironment } from "../src/import-environment.js";

const projects = [
  { id: "proj", paths: ["/work/app"] },
  { id: "personal", personal: true, paths: ["/Users/me"] },
];

describe("import environment", () => {
  it("uses project-default at the project root (ISC-46)", () => {
    expect(
      resolveImportEnvironment({
        directory: "/work/app",
        hostId: "h",
        currentProjectId: "proj",
        projects,
      }),
    ).toEqual({
      projectId: "proj",
      environment: { type: "project-default" },
    });
  });

  it("uses an unmanaged host path for another existing path (ISC-47)", () => {
    expect(
      resolveImportEnvironment({
        directory: "/work/app/pkg",
        hostId: "h",
        currentProjectId: "proj",
        projects,
      }),
    ).toEqual({
      projectId: "proj",
      environment: {
        type: "host",
        hostId: "h",
        workspace: { type: "unmanaged", path: "/work/app/pkg" },
      },
    });
  });

  it("lands outside all projects in the personal project (ISC-48)", () => {
    expect(
      resolveImportEnvironment({
        directory: "/tmp/scratch",
        hostId: "h",
        currentProjectId: "proj",
        projects,
      }).projectId,
    ).toBe("personal");
  });
});
