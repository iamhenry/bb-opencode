export interface OpenCodeTodo {
  id?: string;
  content?: string;
  status?: string;
  priority?: string;
}

export type PlanStepStatus = "pending" | "active" | "completed" | "failed";

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

const TODO_TOOLS = new Set(["todo", "todowrite", "todo_write", "todoread", "todo_read"]);

export function isTodoToolName(name: string): boolean {
  return TODO_TOOLS.has(name.toLowerCase());
}

export function parseOpenCodeTodos(raw: unknown): OpenCodeTodo[] {
  if (Array.isArray(raw)) return raw.filter(isTodoRecord);
  if (!raw || typeof raw !== "object") return [];
  const record = raw as { todos?: unknown; data?: unknown };
  if (Array.isArray(record.todos)) return record.todos.filter(isTodoRecord);
  if (Array.isArray(record.data)) return record.data.filter(isTodoRecord);
  return [];
}

function isTodoRecord(value: unknown): value is OpenCodeTodo {
  return Boolean(value && typeof value === "object");
}

export function planStepStatusOf(status: string | undefined): PlanStepStatus {
  const normalized = (status ?? "pending").toLowerCase();
  if (normalized === "in_progress" || normalized === "active") return "active";
  if (normalized === "completed" || normalized === "done") return "completed";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "failed") {
    return "failed";
  }
  return "pending";
}

export function planStepsFromTodos(todos: readonly OpenCodeTodo[]): PlanStep[] {
  return todos
    .map((todo) => {
      const step = typeof todo.content === "string" ? todo.content.trim() : "";
      if (!step) return null;
      return { step, status: planStepStatusOf(todo.status) };
    })
    .filter((step): step is PlanStep => step !== null);
}

export function todoSnapshotKey(todos: readonly OpenCodeTodo[]): string {
  return JSON.stringify(
    todos.map((todo) => [todo.id ?? "", todo.content ?? "", todo.status ?? ""]),
  );
}

export function todoPlanDeltas(todos: readonly OpenCodeTodo[]): Array<Record<string, unknown>> {
  const steps = planStepsFromTodos(todos);
  return [
    {
      kind: "item.close",
      key: { channel: "planSteps" },
      status: "completed",
      item: { type: "planSteps", steps },
      presentation: {
        label: { pending: "Updating plan", completed: "Updated plan" },
        icon: { glyph: "ListTodo" },
        suppress: true,
      },
    },
  ];
}
