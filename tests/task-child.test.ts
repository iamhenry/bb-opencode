import { describe, expect, it } from "vitest";
import {
  taskChildPrompt,
  taskChildSessionId,
  taskDelegationLabel,
  taskResultSummary,
} from "../src/task-child.js";

describe("task child", () => {
  it("reads the OpenCode child session id from tool state", () => {
    expect(
      taskChildSessionId({
        tool: "task",
        state: { metadata: { sessionID: "ses_child" } },
      }),
    ).toBe("ses_child");
    expect(taskChildSessionId({ tool: "read", state: {} })).toBeUndefined();
  });

  it("reads the Task prompt for the child thread seed", () => {
    expect(
      taskChildPrompt({
        state: { input: { prompt: "Find the package name", description: "pkg" } },
      }),
    ).toBe("Find the package name");
  });

  it("prefers description over the generic Task title", () => {
    expect(
      taskDelegationLabel({
        state: {
          title: "Task",
          input: { description: "Trace todo event flow", subagent_type: "general" },
        },
      }),
    ).toBe("Trace todo event flow");
  });

  it("unwraps OpenCode task XML into the result text", () => {
    expect(
      taskResultSummary(
        `<task id="ses_1" state="completed">\n<task_result>\nbb-plugin-opencode\n</task_result>\n</task>`,
      ),
    ).toBe("bb-plugin-opencode");
    expect(taskResultSummary("<task id=\"ses_1\" state=\"completed\"></task>")).toBeUndefined();
    expect(taskResultSummary("plain")).toBe("plain");
  });

  it("bounds duplicated task output retained in delegation summaries", () => {
    const summary = taskResultSummary(`<task_result>${"x".repeat(20_000)}</task_result>`);
    expect(summary?.length).toBeLessThan(4_200);
    expect(summary).toContain("truncated");
  });
});
