import { describe, expect, it } from "vitest";
import { taskChildSessionId, taskDelegationLabel } from "../src/task-child.js";

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
});
