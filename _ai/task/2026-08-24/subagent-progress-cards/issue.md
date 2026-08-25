# Subagent Progress Cards

## Original GitHub Issue

Add OpenCode subagent work to the BB chat session using native BB UI where possible. While a subagent runs, show its task and a compact stream of recent events; keep older activity collapsed; show the final output when complete. Use OpenChamber as UX reference, preserve the plugin's architecture, and keep scope small.

## Acceptance Criteria

- A running OpenCode subagent is represented inline in its parent BB chat session.
- The representation identifies the subagent task and shows a bounded list of its most recent meaningful events.
- Older events do not expand the chat indefinitely and remain available through a compact disclosure when supported by native BB UI.
- Completion replaces or resolves live progress into one final output without duplicate chat content.
- Missing, delayed, or unsupported subagent events degrade safely without disrupting ordinary OpenCode messages.
- Existing non-subagent streaming behavior remains unchanged.

## Gherkin Happy Path

### Happy Path: Follow a subagent from work to result

Given an OpenCode assistant delegates work to a subagent in a BB chat session
When the subagent emits work events and then completes
Then the parent chat shows its task, a bounded view of recent activity, and one final output without flooding the transcript

## Gherkin Edge Path

### Edge Path: Preserve chat when subagent activity is incomplete

Given a subagent event is delayed, missing, or not recognized
When BB renders the parent chat session
Then ordinary messages remain usable and the subagent area stays stable without duplicate or broken output

## Research Index

- [Code archaeology](./research/code-archaeology.md)
- [Dependency map](./research/dependency-map.md)
- [UX behavior](./research/ux-behavior.md)
- [Style fingerprint](./research/style-fingerprint.md)
- [External signal](./research/external-signal.md)

## Approaches

### A. Native delegation projection — recommended

Keep the existing BB `delegation` item and `parentRef` nesting. Filter child projection to operational activity; leave child prose/reasoning out so the parent Task summary is the single final Output. No plugin frontend code.

- Complexity: low
- Estimate: 30–60 minutes including tests
- Regression probe: nested child tool remains; nested child text/reasoning disappear; parent result remains once.

### B. Plugin content-script Task card

Build a React/content-script clone of OpenChamber and poll an RPC for child activity.

- Complexity: high
- Rejected: duplicates BB state/UI, relies on host DOM, adds polling and accessibility work.
- Regression probe: custom and native cards never duplicate one Task.

### C. Server-collapsed synthetic summary

Replace nested deltas with a custom rolling summary payload rendered by a plugin component.

- Complexity: medium-high
- Rejected: new contract/state path and poorer native event fidelity.
- Regression probe: reconnect/replay produces the same bounded list without clobbering live state.

## Judge Decision

Selected A after independent Kimi 3 and Grok 4.6 critiques.

- Agreement: retain BB native delegation; reject custom frontend/RPC/polling.
- Revision: suppress all four child prose/reasoning variants across snapshot and `session.next` paths, and avoid prose-only empty turns.
- Guardrail: preserve unknown non-prose operational events and keep the parent Task close summary as the only Output source.
