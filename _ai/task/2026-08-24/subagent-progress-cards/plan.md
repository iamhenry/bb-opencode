# Plan

## Goal

Use BB's native delegation card to show OpenCode subagent operational activity and one terminal Output without duplicate child prose.

## How it works

1. Keep the existing Task `delegation`, `childRef`, `parentRef`, and `item.close` summary contract.
2. Deny-list child text and reasoning part/event types at the shared bridge projection boundary.
3. Do not open a nested child turn when only prose/reasoning was received.
4. Preserve all child operational and unknown non-prose parts.
5. Verify live part events and `session.next` events; leave parent text behavior unchanged.

## Acceptance criteria

- Child tools remain nested under the native Task delegation.
- Child text, text deltas, reasoning, and reasoning deltas are not nested.
- Prose-only child updates emit no empty nested turn.
- Parent Task summary remains the single Output source.
- No frontend component, RPC, polling loop, dependency, or plugin-owned display cap is added.

## Scope

- Files: `src/bridge.ts`, `tests/bridge.test.ts`.
- Complexity: low.
- Estimate: under one hour including verification.

## Verification target

- Platform: non-ui
- Objective: prove Task child operational events remain nested while child prose/reasoning cannot duplicate the native final Output.
- Primary Flow: register a Task child, emit live and `session.next` prose/reasoning, then emit a child read tool.
- Regression Check: ordinary provider bridge suite, typecheck, and plugin build remain green.
- Evidence Required: passing targeted/full tests, typecheck, and build output.
- Pass Criteria: prose-only child events emit no deltas or empty turn; child read emits native `parentRef` nesting; all checks exit zero.
- Blocked Conditions: none known.
