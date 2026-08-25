# Code archaeology

- `src/map-delta.ts:198-209` already maps OpenCode `task` to BB's native `delegation` item, including child reference, label, and terminal summary.
- `src/map-delta.ts:346-391` opens/closes that item with native Bot presentation.
- `src/bridge.ts:1121-1199` routes child-session events into the parent thread.
- `src/bridge.ts:1442-1468` projects every child part with `parentRef`; this currently includes child text and reasoning as well as operational tool events.
- `src/bridge.ts:594-660` uses the same projection for polled child snapshots, so one central filter covers both live SSE and reconciliation.
- `tests/bridge.test.ts:496-564` proves nested child tools already reach the native delegation row.
- `tests/map-delta.test.ts:124-143` proves `parentRef` is preserved.

Smallest seam: filter child projection in `projectChildParts` to operational parts before opening the nested turn. Keep parent Task close/output mapping unchanged.
