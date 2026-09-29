# UX behavior

## Current UX

- In a BB OpenCode thread, the registered “Revert from here” action is offered by the host on user and assistant messages. The configured `Undo2` name is unknown to BB's HugeIcons registry and falls back to a generic icon (`app.tsx:48-60`; BB SDK 0.4.16 describes the global action as user-and-assistant chrome at `bb-plugin-sdk-app.d.ts:1740-1757`).
- Despite the ticket saying “v1 one-shot,” this candidate already sends stage and clear through the v2 client (`src/client.ts:417-423`). After a successful stage, the dock previews reverted prompts, restores the selected prompt text to the composer, and offers “Undo revert”; it does not offer a dock Commit action (`src/app/revert-dock.tsx:112-194`). The row projection hides the selected BB row and its suffix (`src/revert-projection.ts:21-45`).
- The click settles a running OpenCode session and then waits for the BB thread to settle before staging (`src/host-handlers.ts:217-230`; `server.ts:1658-1719`). This is source evidence, not a live UI observation for this intake.
- BB message id is used to find BB timeline rows; provider history is then selected by exact OpenCode `messageID` only if present, otherwise role/text matching is used (`server.ts:630-636, 1720-1742`; `src/host-handlers.ts:255-269`). Duplicate text can therefore fail as ambiguous instead of proving the clicked message was staged.

## Post-change UX

- On a complete implementation, the back-arrow action is visible only on user prompts. The chosen prompt and later rows are staged out; tracked edits roll back, and the prompt returns to the composer. Restore returns the previous session/file state and composer draft; Commit permanently removes the staged suffix. Reverting a subagent run also stages its descendant sessions.
- **Gap:** current global BB `messageAction` API cannot limit an action to user messages. It always renders as host-owned chrome for both roles; a component-scoped `ThreadChat` action can set `roles`, but this plugin's action is registered globally. Hiding the assistant icon is not achievable through the currently pinned public plugin API without a BB SDK change or fragile DOM manipulation.
- **Gap:** plugin contract and host code lack commit, and current dock only offers clear. The exact behavior of sending a new prompt while a v2 revert is staged must be checked against OpenCode 2.0.18; do not count the plugin's local row-projection transition as proof the provider committed.
- **Gap:** the action's public message reference omits an OpenCode message ID. The current host uses text matching, so duplicate-prompt exactness remains unproven.
- Composer API supports text replacement/focus and preserves attachments, but does not expose a complete draft snapshot. Exact restoration of arbitrary structured/mention state is not guaranteed by the available `useComposer` surface.
