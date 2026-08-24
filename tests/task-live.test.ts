import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundThreadForTaskChild,
  listLiveTaskChildren,
  noteLiveTaskChild,
  rememberBoundTaskChild,
} from "../src/task-live.js";

describe("task-live", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "oc-task-live-"));
    process.env.OC_TASK_LIVE_PATH = join(dir, "task-live.json");
    process.env.OC_TASK_BOUND_PATH = join(dir, "task-bound.json");
  });
  afterEach(() => {
    for (const key of ["OC_TASK_LIVE_PATH", "OC_TASK_BOUND_PATH"] as const) {
      const path = process.env[key];
      if (path && existsSync(path)) unlinkSync(path);
      delete process.env[key];
    }
  });

  it("notes a running child and lists it for the parent", () => {
    noteLiveTaskChild({
      parentThreadId: "thr_parent",
      parentSessionId: "ses_parent",
      childSessionId: "ses_child",
      title: "Find package name",
      running: true,
      now: 1_000,
    });
    expect(listLiveTaskChildren("ses_parent", 1_000)).toEqual([
      {
        parentThreadId: "thr_parent",
        parentSessionId: "ses_parent",
        childSessionId: "ses_child",
        title: "Find package name",
        prompt: null,
        running: true,
        updatedAt: 1_000,
      },
    ]);
    expect(listLiveTaskChildren("ses_other", 1_000)).toEqual([]);
  });

  it("drops stale rows", () => {
    noteLiveTaskChild({
      parentSessionId: "ses_parent",
      childSessionId: "ses_child",
      running: true,
      now: 1_000,
    });
    expect(listLiveTaskChildren("ses_parent", 50_000)).toEqual([]);
  });

  it("remembers a bound BB thread across live-file expiry", () => {
    noteLiveTaskChild({
      parentSessionId: "ses_parent",
      childSessionId: "ses_child",
      running: true,
      now: 1_000,
    });
    rememberBoundTaskChild("ses_child", "thr_bound");
    expect(boundThreadForTaskChild("ses_child")).toBe("thr_bound");
    expect(listLiveTaskChildren("ses_parent", 1_000)[0]?.boundThreadId).toBe(
      "thr_bound",
    );
  });
});
