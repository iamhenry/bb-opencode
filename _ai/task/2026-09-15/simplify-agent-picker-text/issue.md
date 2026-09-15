# Agent Picker: Drop "Agent" Label, Show Only Icon + Agent Name

## Original GitHub Issue

[iamhenry/bb-opencode#12](https://github.com/iamhenry/bb-opencode/issues/12) — OPEN as of intake (2026-09-15).

**Problem (restated in plain language):** The agent picker trigger button in the toolbar renders as `<icon> Agent <name>` (e.g. "🤖 Agent **build**"). The word "Agent" is redundant: the robot icon already conveys what the picker selects, and the dropdown items themselves show only the agent name. The extra label is toolbar noise.

**Outcome (from issue):** The picker button shows only the icon and the selected agent's name — `<icon> build` instead of `<icon> Agent build`.

**Out of scope (from issue):** Changes to the dropdown item layout or descriptions.

**Evidence attached to issue:** Screenshot showing the button reading "🤖 Agent **build**" while open.

## Acceptance Criteria

From the issue, verbatim:

- [ ] Agent picker trigger displays `<icon> <agent-name>` with no "Agent" prefix label
- [ ] Dropdown list behavior is unchanged (agent names + descriptions still render as before)

## Gherkin Happy Path

### Happy Path: Trigger shows icon and agent name only

Given the agent picker is rendered in the toolbar with an agent selected
When the trigger button is displayed
Then it shows the picker icon followed by the selected agent's name with no "Agent" prefix label

## Gherkin Edge Path

### Edge Path: Dropdown behavior is untouched

Given the trigger label change is applied
When the user opens the agent picker dropdown
Then agent names and descriptions render exactly as before the change

## Research Index

Compact research — inline citations in this file; no `research/` reports (SMALL scope, all lenses answered locally).

### Current Behavior (Code Archaeology)

- The trigger button is rendered by a single shared `AgentPicker` component: `src/app/composer-agent.tsx:43-360`. Two exported wrappers mount it — `ComposerAgentPicker` (expanded, `composer-agent.tsx:34-36`) and `CompactComposerAgentPicker` (compact, `composer-agent.tsx:39-41`).
- The redundant label is exactly one JSX line: `<span className="oc-agent__prefix">Agent</span>` at `src/app/composer-agent.tsx:301`, sitting between `<BotIcon />` (`:300`) and the name span `<span className="oc-agent__name">{selected?.name ?? "build"}</span>` (`:302`).
- The dropdown menu is a separate portal (`composer-agent.tsx:306-355`): items render `option.name` (`:339-341`) and `option.description` (`:342-346`) — independent of the trigger's prefix span.
- Accessibility is independent of the visible prefix: `aria-label={`OpenCode agent: ${selected?.name ?? "build"}`}` (`composer-agent.tsx:295`) and `title` (`:296`) never contain the "Agent" word as a visible prefix label.

### Dependency Map (Callers / Consumers / Blast Radius)

- Mount points: `app.tsx:66-77` registers the composer customization — `actions: [{ id: "agent", component: ComposerAgentPicker }]` (`app.tsx:69`) and banner `CompactComposerAgentPicker` (`app.tsx:72-75`). Both wrappers render the same `AgentPicker`, so removing the prefix span inside `AgentPicker` covers both layouts with one edit.
- No other file renders `oc-agent__prefix` or the "Agent" trigger text: repo grep for `oc-agent__prefix` matches only `composer-agent.tsx:301` (usage) and `composer-agent.css:55,310` (styling). No test asserts the "Agent" prefix string (grep over `tests/` for `oc-agent__prefix` / `"Agent"` prefix text: no matches).
- Tests touching the picker assert behavior, not trigger text: `tests/shipped-imports.test.ts:81-85` (picker must not issue RPC on change — reads `src/app/composer-agent.tsx` as text and checks `setAgent(option.name)` present, `switchAgent`/`noReply` absent — unaffected by removing the prefix span), `tests/composer-chrome.test.ts`, `tests/live-provider.test.ts`, `tests/selectable-primaries.test.ts` (option/hydration logic, untouched).
- Blast radius: one TSX line + two now-dead CSS rules. No RPC contract, no state logic, no dropdown code affected.

### UX Behavior

**Current UX:** Toolbar trigger reads `🤖 Agent build` (icon, "Agent" prefix span, agent name, chevron) — `composer-agent.tsx:300-303`. Opening it shows the "Primary agents" listbox with name + description rows (`composer-agent.tsx:318-348`). In compact/coarse-pointer layout the prefix is already hidden by CSS: `.oc-agent[data-layout="compact"] .oc-agent__prefix { display: none; }` (`composer-agent.css:310-312`) — so compact users already see the target state.

**Post-change UX:** Trigger reads `🤖 build` in both layouts (icon + name, no prefix). Dropdown unchanged: same names, descriptions, selection behavior. `aria-label`/`title` unchanged. Compact layout loses nothing (prefix was already hidden there).

### Style Fingerprint (cheatsheet)

- One component per concern in `src/app/`, co-located `.css` next to `.tsx` (`composer-agent.tsx:26` imports `./composer-agent.css`).
- BEM-ish class naming: `oc-agent`, `oc-agent__prefix`, `oc-agent__name`, `oc-agent-menu__item` (`composer-agent.css:55-66`, `composer-agent.tsx:301-302`).
- Tests are behavior-level vitest specs under `tests/*.test.ts`; DOM-adjacent rules are asserted as source-text checks (`tests/shipped-imports.test.ts:82-85`).
- Checks: `npm run typecheck`, `npm run test` (vitest), `npm run build` (`package.json` scripts).

### Constraints

- Dropdown item layout and descriptions must not change (issue out-of-scope; `composer-agent.tsx:318-348` untouched).
- `aria-label`, `title`, icon, chevron, and all picker state/RPC behavior stay as-is (`composer-agent.tsx:295-303`, `:166-201`).
- Changes must look maintainer-written: minimal diff, existing class conventions.

### Runtime / Proof Path (for later verification stage, not run here)

- Plugin mounts via BB (`package.json` `bb` block: `app: "./app.tsx"`); prior verification convention is web-platform screenshots under `{ISSUE_DIR}/verification/screenshots/` with a `result.md` verdict (see `_ai/task/2026-08-24/subagent-progress-cards/verification/result.md`). The trigger is visible in a real BB chat composer with the OpenCode plugin active — same path prior missions used.

## Approaches

### A. Delete the prefix span and its now-dead CSS — recommended (only supported approach)

Remove `<span className="oc-agent__prefix">Agent</span>` at `src/app/composer-agent.tsx:301`, then delete the two CSS rules that exist only for that span: `.oc-agent__prefix` block (`src/app/composer-agent.css:55-58`) and the compact hide rule `.oc-agent[data-layout="compact"] .oc-agent__prefix` (`composer-agent.css:310-312`). Everything else — icon, name span, chevron, aria-label, title, dropdown — untouched.

- Complexity: trivial; ~4 deleted lines, 0 added.
- Satisfies acceptance: trigger renders `<icon> <name>` (`composer-agent.tsx:300-302` minus `:301`); dropdown untouched (`composer-agent.tsx:318-348`).
- Regression probe: existing suite `npm run typecheck && npm run test` (source-text check `tests/shipped-imports.test.ts:82-85` still passes since `setAgent(option.name)` remains); plus rendered-UI screenshot of the trigger showing `🤖 build` with dropdown open showing unchanged name+description rows.
- Would a maintainer approve without changes? Yes — pure deletion on the exact line the issue names, no new concepts.

No alternative is meaningfully supported: a CSS-only `display:none` on the expanded prefix would leave dead markup and diverge from the compact path's existing delete-style; any component refactor violates minimal-diff/YAGNI. Fabricating alternatives would add no decision value.

## Judge Decision

Status: SELECTED
Selected Approach: A. Delete the prefix span and its now-dead CSS
Confidence: High

Scores:
- A. Delete the prefix span and its now-dead CSS: 100/100 - Pure deletion on the exact cited line satisfies both acceptance criteria with the smallest possible diff, fully supported by inline evidence.

Decision:
- All hard gates pass: deleting `composer-agent.tsx:301` directly produces the requested `<icon> <name>` trigger (issue.md:19, :86) while dropdown rows (`composer-agent.tsx:318-348`), `aria-label`/`title` (`:295-296`), and picker state/RPC behavior (`:166-201`) stay untouched — no scope added, no intermediate result substituted.
- Evidence is complete and cited: the prefix is one JSX line (`composer-agent.tsx:301`) plus two now-dead CSS rules (`composer-agent.css:55-58`, `:310-312`); repo grep shows no other renderer of `oc-agent__prefix` and no test asserting the "Agent" prefix string (issue.md:52-53), so the deletion is complete and regression-safe.
- Compact layout already proves the target state via the existing CSS hide rule (`composer-agent.css:310-312`, issue.md:58), so the change converges both layouts on an already-shipped UX — strong ETHOS/pragmatic-shipping alignment.
- Verification is clear and available: `npm run typecheck && npm run test` (source-text check `tests/shipped-imports.test.ts:82-85` unaffected) plus a rendered-UI screenshot of the trigger and open dropdown (issue.md:87); trivially reversible via git.

Question:
N/A