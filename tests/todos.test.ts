import { describe, expect, it } from "vitest";
import {
  isTodoToolName,
  parseOpenCodeTodos,
  planStepStatusOf,
  planStepsFromTodos,
  todoPlanDeltas,
  todoSnapshotKey,
} from "../src/todos.js";

describe("OpenCode todos", () => {
  it("maps OpenCode statuses onto BB plan steps (ISC-93)", () => {
    expect(planStepStatusOf("in_progress")).toBe("active");
    expect(planStepStatusOf("completed")).toBe("completed");
    expect(planStepStatusOf("cancelled")).toBe("failed");
    expect(planStepStatusOf("pending")).toBe("pending");
    expect(
      planStepsFromTodos([
        { id: "1", content: "Write tests", status: "in_progress" },
        { id: "2", content: "  ", status: "pending" },
        { id: "3", content: "Ship", status: "completed" },
      ]),
    ).toEqual([
      { step: "Write tests", status: "active" },
      { step: "Ship", status: "completed" },
    ]);
  });

  it("unwraps todo lists from event envelopes", () => {
    expect(
      parseOpenCodeTodos({
        todos: [{ content: "One", status: "pending" }],
      }),
    ).toHaveLength(1);
    expect(parseOpenCodeTodos([{ content: "Two" }])).toHaveLength(1);
    expect(parseOpenCodeTodos({ data: [{ content: "Three" }] })).toHaveLength(1);
    expect(parseOpenCodeTodos(null)).toEqual([]);
  });

  it("emits a channel-keyed planSteps snapshot", () => {
    expect(
      todoPlanDeltas([{ content: "Do it", status: "pending" }]),
    ).toEqual([
      {
        kind: "item.close",
        key: { channel: "planSteps" },
        status: "completed",
        item: {
          type: "planSteps",
          steps: [{ step: "Do it", status: "pending" }],
        },
        presentation: {
          label: { pending: "Updating plan", completed: "Updated plan" },
          icon: { glyph: "ListTodo" },
          suppress: true,
        },
      },
    ]);
  });

  it("treats todo tools as plan snapshots, not generic rows", () => {
    expect(isTodoToolName("todowrite")).toBe(true);
    expect(isTodoToolName("Todo")).toBe(true);
    expect(isTodoToolName("bash")).toBe(false);
  });

  it("dedupes unchanged snapshots", () => {
    const a = [{ id: "1", content: "A", status: "pending" }];
    const b = [{ id: "1", content: "A", status: "pending" }];
    expect(todoSnapshotKey(a)).toBe(todoSnapshotKey(b));
  });
});
