# Plan: Agent Picker — Drop "Agent" Label, Show Only Icon + Agent Name

Source of truth: `{ISSUE_DIR}/issue.md` (GitHub issue [iamhenry/bb-opencode#12](https://github.com/iamhenry/bb-opencode/issues/12)). Selected approach: **A — delete the prefix span and its now-dead CSS** (`Judge Decision: SELECTED`, 100/100). This plan is deletion-only; no implementation happens here.

## Executive Summary

- **What's broken?** The agent picker trigger reads `🤖 Agent build`; the word "Agent" is redundant toolbar noise.
- **What's the fix?** Delete the single prefix span and the two CSS rules that exist only for it.
- **What happens after the fix?**
  - Expanded-layout user: trigger reads `🤖 build` (icon + name + chevron).
  - Compact-layout user: unchanged — the prefix was already CSS-hidden there (`composer-agent.css:310-312`).
  - All users: dropdown rows, descriptions, selection behavior, `aria-label`, `title` unchanged.
- **What changes?**
  - `src/app/composer-agent.tsx`: remove line 301 (`<span className="oc-agent__prefix">Agent</span>`).
  - `src/app/composer-agent.css`: delete the `.oc-agent__prefix` rule (lines 55-58) and the compact hide rule (lines 310-312).
- **What's the risk?** Minimal — pure deletion on the exact line the issue names. Protected: dropdown markup (`composer-agent.tsx:318-348`), `aria-label`/`title` (`:295-296`), picker state/RPC behavior (`:166-201`). Fallback: trivially reversible via git.
- **What's on me?** Nothing manual; verification runs in the real BB/OpenCode UI by later gate owners.

## Acceptance Criteria

Carried forward unchanged from `issue.md:19-20` (GitHub issue #12):

- [ ] Agent picker trigger displays `<icon> <agent-name>` with no "Agent" prefix label
- [ ] Dropdown list behavior is unchanged (agent names + descriptions still render as before)

## User Story

As a BB/OpenCode user, I want the agent picker trigger to show only the icon and the selected agent's name so the toolbar is not cluttered with a redundant "Agent" label.

## Gherkin Scenarios

### Scenario: Trigger shows icon and agent name only

Given the agent picker is rendered in the toolbar with an agent selected
When the trigger button is displayed
Then it shows the picker icon followed by the selected agent's name with no "Agent" prefix label

Acceptance Criteria References:

- Agent picker trigger displays `<icon> <agent-name>` with no "Agent" prefix label

### Scenario: Dropdown behavior is untouched

Given the trigger label change is applied
When the user opens the agent picker dropdown
Then agent names and descriptions render exactly as before the change

Acceptance Criteria References:

- Dropdown list behavior is unchanged (agent names + descriptions still render as before)

## Scope & Boundaries

### In Scope

- [ ] Delete `<span className="oc-agent__prefix">Agent</span>` at `src/app/composer-agent.tsx:301`
- [ ] Delete `.oc-agent__prefix` rule at `src/app/composer-agent.css:55-58`
- [ ] Delete `.oc-agent[data-layout="compact"] .oc-agent__prefix` rule at `src/app/composer-agent.css:310-312`

### Out of Scope

- Dropdown item layout, names, or descriptions (`composer-agent.tsx:318-348`)
- `aria-label`, `title`, icon, chevron, picker state/RPC logic (`composer-agent.tsx:295-303`, `:166-201`)
- New test infrastructure, component refactors, CSS-only `display:none` alternatives
- Commits, push, PR, merge (later owners; merge forbidden)

## Codebase Orientation

- Shared component: `AgentPicker` in `src/app/composer-agent.tsx:43-360`; both exported wrappers (`ComposerAgentPicker` :34-36, `CompactComposerAgentPicker` :39-41) render it, so one edit covers both layouts.
- The prefix span sits between `<BotIcon />` (`composer-agent.tsx:300`) and the name span (`:302`).
- Repo grep: `oc-agent__prefix` appears only at `composer-agent.tsx:301` (usage) and `composer-agent.css:55,310` (styling) — no other renderer, no test asserts the "Agent" prefix string.
- Key patterns: one component per concern, co-located `.css` next to `.tsx` (`composer-agent.tsx:26`), BEM-ish `oc-agent__*` classes.
- Dev commands: `npm run typecheck`, `npm run test`, `npm run build` (`package.json:26-30`).

## Dependencies

- None added. Existing checks: `npm run typecheck` (tsc), `npm run test` (vitest, includes `tests/shipped-imports.test.ts:81-86` which asserts `setAgent(option.name)` present and `switchAgent`/`noReply` absent — unaffected by this deletion).

## Deliverables

- Modified: `src/app/composer-agent.tsx` (1 line deleted)
- Modified: `src/app/composer-agent.css` (2 rules deleted, ~6 lines)
- Verification evidence under `{ISSUE_DIR}/verification/` (owned by verification-gate, not this plan)

## Error Handling

1. **Scenario: A test or typecheck fails after deletion.**
   - **Handling:** Stop; the only plausible cause is an unexpected consumer of `oc-agent__prefix` — re-grep and report before proceeding.
   - **User Impact:** None; change is not committed.
2. **Scenario: Rendered UI still shows "Agent" prefix.**
   - **Handling:** The candidate was not loaded (stale build); reload the exact candidate and re-capture.
   - **User Impact:** None until resolved.

## 🧩 Implementation Checklist

### Phase 1: Implementation Tasks

**Task 1.1: Delete the prefix span**

- [ ] MODIFY: Remove the single line `<span className="oc-agent__prefix">Agent</span>` from `src/app/composer-agent.tsx:301`, leaving `<BotIcon />` (`:300`) and the name span (`:302`) adjacent.
- NOTE: Do not touch `aria-label` (`:295`), `title` (`:296`), chevron (`:303`), or the dropdown portal (`:305-355`).

**Task 1.2: Delete the now-dead CSS rules**

- [ ] MODIFY: Delete the `.oc-agent__prefix { flex: none; opacity: 0.8; }` block at `src/app/composer-agent.css:55-58`.
- [ ] MODIFY: Delete the `.oc-agent[data-layout="compact"] .oc-agent__prefix { display: none; }` rule at `src/app/composer-agent.css:310-312` (inside the `@media (pointer: coarse)` block — remove only that rule, keep the block and the `.oc-agent--banner` rule at `:306-308`).
- NOTE: After both tasks, repo grep for `oc-agent__prefix` must return zero matches.

**Task 1.3: Run mechanical checks**

- [ ] VERIFY: `npm run typecheck && npm run test` exits 0. `tests/shipped-imports.test.ts:81-86` still passes because `setAgent(option.name)` (`composer-agent.tsx:334`) remains and no `switchAgent`/`noReply` is introduced.

### Phase 2: Verification Gate

Once implementation is complete, obtain `code-quality-gate` approval, then `verification-gate` acceptance before any authorized commit. Dispatch them as separate fresh sessions; neither gate is performed by the implementer.

- [ ] **web**: Real BB/OpenCode UI verification per the Verification Target below.

### Phase 3: Commit Changes

Local edits, tests, commit, push, and PR creation are authorized for later owners; **merge is forbidden**. Only after both gates pass, use the repo's normal commit conventions.

- [ ] **Create Commit**: Attempt the commit after Phase 2 passes.
- [ ] **Handle Hook Failures**: If commit hooks fail, inspect the output, fix the issues, and retry. Do not bypass hooks.

## Verification Target

Use the `verification-gate` skill's platform routes and evidence rules to prove the task works before any authorized commit.

- **Platform**: `web`
- **Objective**: In the actual BB/OpenCode UI, the agent picker trigger renders `<icon> <agent-name>` with no "Agent" prefix, and the open dropdown still shows agent names + descriptions as before.
- **Falsifier**: The rendered trigger still shows the "Agent" prefix, or the dropdown rows lose names/descriptions/selection behavior.
- **Primary Flow**: Load the exact candidate build (identify it by the working-tree commit containing the deletion, baseline `c9fbe52f43956cbdc8df29d9f1ac17e0609e7e31` + the change) in the real BB app with the OpenCode plugin active (`package.json:22` `app: "./app.tsx"`). Open a chat composer, locate the agent picker trigger in the toolbar, click it to open the dropdown, and inspect both the trigger label and the open dropdown in one screenshot if practical.
- **Regression Check**: With the dropdown open, confirm rows still render `option.name` + `option.description` and selecting an agent closes the menu and updates the trigger name (`composer-agent.tsx:331-337`).
- **Mechanical**: `npm run typecheck && npm run test` exits 0 (includes `tests/shipped-imports.test.ts:81-86` asserting the picker's no-RPC-on-change behavior is intact).
- **Observable**: `{ISSUE_DIR}/verification/screenshots/agent-picker-trigger.png` — one actual rendered screenshot showing the trigger (icon + agent name, no "Agent" prefix) with the dropdown open showing unchanged name + description rows. A terminal, test runner, or source file is not Observable evidence.
- **Pass Criteria**: Mechanical command exits 0 AND the screenshot shows the trigger reading `<icon> <agent-name>` (no "Agent" text) with the dropdown open rendering unchanged name + description rows.
- **Blocked Conditions**: No running BB/OpenCode runtime or plugin activation permission available → prerequisite owner: mission host; unlock: a BB session with the OpenCode plugin loaded where the composer toolbar is reachable.

## Manual QA Checklist

- [ ] None — all verification is agent-runnable in the real BB/OpenCode UI.

## Plan Judge

- Decision: `APPROVE_PLAN`
- Score: 100
- Chosen proposal: Approach A — delete the `oc-agent__prefix` span (`composer-agent.tsx:301`) and its two now-dead CSS rules (`composer-agent.css:55-58`, `:310-312`).
- Checked: issue.md, plan.md, create-issue reference (`02-create-issue.md`); no `research/` files exist (inline citations per issue.md:40); ETHOS not present in repo.

### Notes

- All required sections present and well-formed; Verification Target carries all nine fields with Platform `web`, a named Mechanical command (`npm run typecheck && npm run test` — includes a behavior-asserting test, not lint-only), and a retained app-owned Observable screenshot path that explicitly excludes terminal/test/source substitutes (plan.md:130-138).
- Fidelity is exact: deletion-only scope matches Approach A line-for-line (plan.md:56-58 vs issue.md:83); dropdown, `aria-label`/`title`, and picker state are fenced out with citations (plan.md:62-63); Pass Criteria requires Mechanical AND the rendered screenshot, so Mechanical alone cannot complete the task (plan.md:137).

### Required Changes

- None