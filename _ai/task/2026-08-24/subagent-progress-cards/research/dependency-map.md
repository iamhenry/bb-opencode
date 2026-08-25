# Dependency map

- Producer: OpenCode child session SSE and message snapshots (`src/bridge.ts:1121-1199`, `src/bridge.ts:629-655`).
- Normalizer: `projectChildParts` -> `mapPartDelta` (`src/bridge.ts:1442-1468`).
- Contract: BB provider bridge `parentRef` joins nested items to the delegation; SDK docs at `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-provider-bridge.d.ts:2903-2907,3053-3062`.
- Consumer: BB native timeline; no plugin React component is required.
- Terminal output: parent Task `item.close` carries `summary` from `taskResultSummary` (`src/task-child.ts:66-73`, `src/map-delta.ts:198-209,372-391`).
- Blast radius: one bridge helper and focused bridge assertions. Parent messages, generic tools, child-thread binding, RPC, and app content scripts remain untouched.
- Breaking risk: filtering too broadly could hide child tools. Restrict to non-text/non-reasoning operational parts and retain unknown operational types for compatibility.
- Regression probe: child read is nested; child text/reasoning are absent; parent Task closes with one summary; ordinary parent text still streams.
