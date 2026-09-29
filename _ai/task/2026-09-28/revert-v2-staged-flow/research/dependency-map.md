# Dependency map

## Call path and dependent surfaces

1. BB renders the registered global action from `app.tsx:48-60`; BB supplies `message.id`, `role`, and `text`.
2. `src/app/message-revert.ts:4-24` invokes RPC `undo`; `contract.ts:362-373` validates its payload; `server.ts:630-636` routes to `revertThread`.
3. `server.ts:1682-1769` serially resolves the BB thread/provider/session, waits for OpenCode and BB quiescence, computes hidden BB row IDs, invokes host `revert` or `unrevert`, stores the projection, and publishes one realtime notification.
4. `host.ts:88-102` dispatches to `src/host-handlers.ts:247-291`; the host reads session history/state and calls the `OpenCodeClient` adapter in `src/client.ts:417-423`.
5. `RevertDock` consumes `revertState` and realtime notifications, restores the prompt into the composer, and currently clears the staged revert (`src/app/revert-dock.tsx:67-155`). The timeline content script independently hides rows using the hidden-row ID list (`src/app/revert-timeline.ts:52-82`).

## Producer/consumer and blast radius

- **Icon and role visibility:** one app registration (`app.tsx:48-60`), SDK registration type, and BB's host-rendered message action UI. Changing the registration affects every provider thread where the globally registered plugin action is shown; the callback currently gates provider execution at `src/app/message-revert.ts:11-15`.
- **Exact message identity:** action reference -> `undo` contract -> server RPC -> host contract -> `resolveRevertMessageId` -> OpenCode stage. Today the BB id is used to locate the BB suffix, while provider resolution uses role/text (`server.ts:630-636, 1720-1742`; `src/host-handlers.ts:255-269`). Dropping or conflating either ID can hide the wrong BB rows or stage the wrong provider prompt. Strict duplicate-text checks currently fail safely rather than picking one (`src/revert-target.ts:55-69`).
- **V2 lifecycle:** update `OpenCodeClient`, host contract/handler, server RPC/contract, and dock. The public provider API already exposes stage/clear and the SDK is the existing call path (`src/client.ts:417-423`). Add a commit path without conflating clear/commit: clear must restore; commit must finalize. Any send-after-stage commit policy should be verified against the exact installed 2.0.18 server before relying on it.
- **Subagent cascade:** direct child queries and live child tracking exist (`src/client.ts:374-379`, `src/task-live.ts:87-128`), as does task-run correlation during a live bridge (`src/bridge.ts:1200-1224`). A correct cascade must stop busy descendants, discover the descendant tree even after the ephemeral registry ages out, derive each cutoff from the target run, and stage/clear/commit the same descendants consistently. Snapshot restores across sessions sharing one directory make ordering a correctness concern; OpenChamber stages descendants before the parent.
- **Session state and events:** OpenCode revert events become `session.updated`, whose bridge handler rereads the session cursor (`src/v2-map.ts:314-319`, `src/bridge.ts:1735-1757`). UI dock state is from `revertState`, not those event details. Existing polling/realtime paths and the row projection are separate consumers, so lifecycle changes must keep provider state and BB projection in agreement.
- **Composer:** `useComposer().setText` and `focus` are already the supported plugin APIs; prior plain text is saved per thread (`src/app/revert-dock.tsx:21-49, 112-155`). Exact structured-draft rollback is not guaranteed by the current SDK contract.

## Public contracts, existing tests, and risks

- Public plugin boundaries are `hostContract` and `rpcContract` (`contract.ts:68-146, 229-386`); OpenCode calls are behind `OpenCodeClient` (`src/client.ts:35-113`). Keep these as the only new lifecycle entry points rather than adding direct browser-to-OpenCode calls.
- Existing relevant tests cover resolver uniqueness, state presentation, projection transitions, hydration cursor, v2 event mapping, and string-based app registration. They do not prove a live UI action, endpoint auth, file restore, commit, or cascade.
- The largest hard blocker is role filtering: the pinned BB SDK global `PluginMessageActionRegistration` has no `roles` property; only the separate, component-scoped `ThreadChatMessageAction` has `roles` (installed SDK 0.4.16 declarations at `bb-plugin-sdk-app.d.ts:1222-1261, 1736-1747`). The current plugin uses the global slot in the native thread timeline. No supported plugin-only way to hide that slot action on assistant messages was found.
- A second behavior gap is exact provider identity: `ThreadChatMessageReference` exposes BB id, role, text, and `sourceSeqEnd`, but not OpenCode `messageID` (installed SDK 0.4.16 `bb-plugin-sdk-app.d.ts:1198-1209`). Current code does not resolve an OpenCode ID from the BB id. The task should not claim duplicate-prompt safety until the mapping is implemented and probed.

## Regression probes for a later implementation

- UI: assert the BB native action appears only on user rows, the glyph is `ArrowTurnBackward`, and clicking a duplicated prompt reverts exactly the clicked turn.
- Lifecycle: stage, verify timeline/file/prompt state; clear and compare history, tracked file, and composer text to the pre-stage receipt; commit and confirm history no longer contains the staged suffix. Also verify submit-after-stage against OpenCode 2.0.18 rather than inferring commit from the BB projection.
- Running path: click during a long turn; verify stop settles before stage and no orphan row remains.
- Cascade: target a user message carrying a completed or live subagent run; verify child stage cutoff, then separately clear and commit across all descendants.
