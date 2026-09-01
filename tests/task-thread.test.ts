import { describe, expect, it } from "vitest";
import {
  TASK_CHILD_BIND_TEXT,
  isOpenCodeParentThread,
  isThreadNotFoundError,
  shouldAutoBindTaskChild,
  splitModelRef,
  taskChildBindInput,
  taskChildThreadTitle,
} from "../src/task-thread.js";

describe("task child threads", () => {
  it("treats OpenCode roots as bind parents even without providerThreadId", () => {
    expect(
      isOpenCodeParentThread({
        providerId: "opencode",
        id: "thr_1",
        projectId: "proj_1",
        parentThreadId: null,
      }),
    ).toBe(true);
    expect(
      isOpenCodeParentThread({
        providerId: "opencode",
        id: "thr_1",
        projectId: "proj_1",
        parentThreadId: "thr_parent",
      }),
    ).toBe(false);
  });

  it("auto-binds only a running child of a bound parent", () => {
    expect(
      shouldAutoBindTaskChild({
        parentBound: true,
        alreadyImported: false,
        running: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoBindTaskChild({
        parentBound: true,
        alreadyImported: false,
        running: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoBindTaskChild({
        parentBound: false,
        alreadyImported: false,
        running: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoBindTaskChild({
        parentBound: true,
        alreadyImported: true,
        running: true,
      }),
    ).toBe(false);
  });

  it("does not stamp OpenCode placeholder titles onto BB", () => {
    expect(taskChildThreadTitle("Child session - 2026-08-23T01:02:03.004Z")).toBe(
      "Task",
    );
    expect(taskChildThreadTitle("Explore package.json")).toBe(
      "Explore package.json",
    );
  });

  it("exposes the hydrated Task prompt as a normal user message", () => {
    expect(taskChildBindInput()).toEqual([
      {
        type: "text",
        text: TASK_CHILD_BIND_TEXT,
        mentions: [],
      },
    ]);
  });

  it("recognizes a missing BB thread without treating other errors as gone", () => {
    expect(
      isThreadNotFoundError(
        new Error('BbHttpError: HTTP 404: Thread not found'),
      ),
    ).toBe(true);
    expect(isThreadNotFoundError(new Error("spawn failed"))).toBe(false);
  });

  it("splits provider/model ids for summarize", () => {
    expect(splitModelRef("openai/gpt-5")).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
    expect(splitModelRef("build")).toBeNull();
  });
});
