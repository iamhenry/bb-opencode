export interface RevertProjectionState {
  committedRowIds: string[];
  stagedRowIds: string[];
}

export const EMPTY_REVERT_PROJECTION: RevertProjectionState = {
  committedRowIds: [],
  stagedRowIds: [],
};

export interface RevertTimelineRow {
  id?: string;
  kind?: string;
  role?: string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * Find the BB turn boundary represented by one clicked message. OpenCode
 * normalizes an assistant target to its preceding user message, so BB must hide
 * from that same user row rather than leaving an orphaned prompt visible.
 */
export function rowIdsHiddenByRevert(
  rows: readonly RevertTimelineRow[],
  clickedMessageId: string,
): string[] {
  let index = rows.findIndex((row) => row.id === clickedMessageId);
  if (index < 0) return [];
  if (rows[index]?.role === "assistant") {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const row = rows[cursor];
      if (row?.kind === "conversation" && row.role === "user") {
        index = cursor;
        break;
      }
    }
  }
  return unique(
    rows.slice(index).flatMap((row) =>
      typeof row.id === "string" && row.id ? [row.id] : [],
    ),
  );
}

export function hiddenRevertRowIds(state: RevertProjectionState): string[] {
  return unique([...state.committedRowIds, ...state.stagedRowIds]);
}

export function stageRevertProjection(
  previous: RevertProjectionState,
  rowIds: readonly string[],
): RevertProjectionState {
  return {
    committedRowIds: unique(previous.committedRowIds),
    stagedRowIds: unique(rowIds),
  };
}

export function undoRevertProjection(
  previous: RevertProjectionState,
): RevertProjectionState {
  return {
    committedRowIds: unique(previous.committedRowIds),
    stagedRowIds: [],
  };
}

export function commitRevertProjection(
  previous: RevertProjectionState,
): RevertProjectionState {
  return {
    committedRowIds: unique([
      ...previous.committedRowIds,
      ...previous.stagedRowIds,
    ]),
    stagedRowIds: [],
  };
}
