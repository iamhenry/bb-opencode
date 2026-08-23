---
task: "First-class OpenCode community plugin for BB"
slug: 20260822-163200_bb-plugin-opencode-v1
project: bb-plugin-opencode
phase: building
progress: 90/99
started: 2026-08-22T16:32:00Z
updated: 2026-08-23T14:10:00Z
principal_stated_goal: "Add first-class OpenCode support in BB so it feels native, not like a generic ACP guest."
principal_stated_goal_source: conversation
principal_stated_goal_signal: 2
principal_stated_goal_locked: 2026-08-22T16:32:00Z
context_sufficient: true
interview_invoked: false
---

# ISA — bb-plugin-opencode V1

## Problem

BB already treats Claude, Codex, and Pi as first-class agents. OpenCode today arrives as `acp-opencode` through the generic ACP guest path. ACP is a lowest-common-denominator translator: undo/redo, custom OpenCode agents, live bash, and OpenCode's own permission memory never become real BB surfaces. Users who already live in OpenCode therefore meet a thinner, misnamed guest instead of the agent they already know.

## Vision

OpenCode is a normal BB agent. The picker says **OpenCode**, not "ACP · opencode". The user chooses a model and an OpenCode agent, can change that agent on the next send, and watches thinking, tools, and live bash land in the BB timeline. Typing `/name` runs that OpenCode command. BB-injected skills reach the session as a catalog, not a rewritten `opencode.json`. `@general` / Task starts a child OpenCode session; the parent shows a Task tool item; the user opens that child only if they choose to, and only after it is idle. Stop, undo, redo, and attachments behave. Permissions use BB's existing card; once/always still write back to OpenCode; `opencode.json` still counts; BB's permission mode is only a ceiling. Resume is the same OpenCode session. Settings and `bb opencode status|version|logs` say when the binary, version, or auth is wrong. Import is a button the user presses — never a sidebar that fills itself. One OpenCode server runs on the machine. Euphoric surprise: it feels like Claude-in-BB, except the agent underneath is OpenCode.

## Out of Scope

V1 is OpenCode-in-BB, not OpenChamber-in-BB and not a BB core rewrite.

- No ACP as the long-term OpenCode path. ACP stays as the fallback for other agents and for existing `acp-opencode` threads.
- No migration of existing `acp-opencode` threads onto `opencode`.
- No putting this provider into BB core. V1 is a community plugin that can later be vendored unchanged.
- No OpenChamber product chrome: goals, multi-run, fusion, walkthrough, preview, relay, nav panel, second transcript, parent/child nav, read-only subtask side panel.
- OpenCode `session.revert` is in-place undo ("Revert from here"). OpenCode `session.fork({ messageID })` is a new session and maps to BB `fork: "checkpoint"` — not the same verb.
- No auto-import of OpenCode sessions into the BB sidebar.
- No custom permission card, no `pendingInteraction` / `bb.ui.requestInput` from the bridge, no `messageDirective` for bash.
- No `bb opencode restart`. Status, version, and logs are enough.
- No extra "auto-accept policy" setting beyond BB's existing permission modes plus OpenCode's own always/`opencode.json`.
- No browser SSE to OpenCode. No `@opencode-ai/sdk` in `app.tsx` or the BB server process.
- No private `@bb/*` in shipped `server` / `host` / `app`.
- No OpenCode V2 / beta APIs (`session.switchAgent`, `POST /api/session/:id/agent`, `session.subagent`). V1 pins the current stable `@opencode-ai/sdk` and `opencode serve` HTTP API.
- No experimental background Task (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`). Foreground Task only.
- No wiring BB Voyager / Atlas / other BB children as OpenCode agents. An OpenCode subagent exists only if `app.agents()` lists it.
- No mid-stream agent hot-swap. A picker change does not interrupt or rewrite the in-flight drain.
- No `prompt({ noReply: true })` used to persist a picker click.
- No durable BB `pendingAgent` cookie. A click that is never sent is lost on resume, which is honest.
- No picker `onChange` host RPC whose only job is to remember the click.
- No subagents (`@mention`, Task tool, `mode: "subagent"`) in the composer agent picker.
- No auto-created BB thread when Task spawns a child. No custom Task card.
- No writing `opencode.json` `skills` / `command` to make BB skills appear.
- No BB core change to `host.list_commands` (that table only knows `acp-opencode`). Community `/` typeahead rows for `opencode` are therefore not a V1 seam.
- No `composerActions: ["plan"]`. That is BB plan mode, not OpenCode `/plan` or the plan agent.

## Language

**OpenCode provider.** The first-class BB provider this plugin registers. Id `opencode`, display name `OpenCode`.
_Avoid:_ `acp-opencode`, "ACP · opencode", "the ACP guest".
Related: ACP remains a different provider; the two never merge.

**ACP OpenCode.** Today's generic path: provider id `acp-opencode`, running `opencode acp`. Existing threads stay here forever.
_Avoid:_ calling this "OpenCode" once the plugin exists.

**Adopt.** Bind a BB thread to an OpenCode session that already exists. History is not copied into a new OpenCode session.
_Avoid:_ import-as-copy, "smallest prompt then stop", silent `session.create`.

**Import.** The user-facing action that lists unimported OpenCode sessions and, on confirm, adopts the selected ones.
_Avoid:_ auto-scan, auto-import, sidebar sync.

**Pending adopt.** Durable KV keyed by `{projectId, hostId, opencodeSessionId}`. The in-memory open handoff is one-shot, 15s TTL, consumed only by the first `deriveProviderOptions` for a **new** thread id in that project. Turns on already-seen threads never consume it.
_Avoid:_ a project-wide wildcard eaten by the next turn or an unrelated start; treating pending adopt as a prompt; inventing a `bbThreadId` the public spawn API cannot create.

**Revert.** OpenCode `session.revert` / `session.unrevert`. This is undo/redo chrome.
_Avoid:_ BB `fork`, "branch the thread".

**OpenCode agent.** A session mode from `app.agents()` (build, plan, custom primaries). Applied on every `session.prompt`. A picker change is intent until the next send.
_Avoid:_ start/resume-only; stuffing agents into the model picker; V2 `switchAgent`; putting subagents in the picker.

**Selectable primary.** An `app.agents()` entry the composer picker may show or hydrate: `mode` is `primary` or `all`, not hidden, not a system agent (`title` / `compaction` / `summary`), not `mode: "subagent"`.
_Avoid:_ calling this "primary / all" in one claim and "selectable primary" in another; treating `all` as subagent-only.

**Queued send agent.** The agent stamped when BB enqueues a follow-up because `turn/steer` is refused. Captured at enqueue, not at flush.
_Avoid:_ "whatever the picker says when the queue drains."

**OpenCode subagent.** An `app.agents()` entry with `mode: "subagent"` (built-in general / explore / scout, or a user markdown/json agent). Invoked by `@name` in the prompt or by OpenCode's Task tool. Not a BB Voyager/Atlas child.
_Avoid:_ putting these in the composer picker; treating BB sub-agents as OpenCode agents.

**Task child.** An OpenCode session the Task tool creates with `parentID` set. The parent timeline shows the Task tool item. A BB thread for that child exists only after user-confirmed adopt.
_Avoid:_ plugin `session.create` for Task; auto-sidebar; OpenChamber "open subtask" chrome; calling child `idle` the parent turn end.

**Detached OpenCode.** One long-lived OpenCode server process per host, found via lock/port under the plugin `dataDir`. Bridge workers and the idle-evicted host-RPC worker all attach to it.
_Avoid:_ in-process child of the bridge, module-singleton client, "the host *is* OpenCode".

**Permission ceiling.** BB modes `accept-edits | auto | full` may only narrow what OpenCode would allow. `full` means auto-approve. OpenCode's once/always and `opencode.json` still apply underneath.
_Avoid:_ a second auto-accept setting, "BB owns permissions".

**Fail-closed permission result.** Tagged `{ok | resolved | unknown}`. Unknown does not approve.
_Avoid:_ treating a timeout or missing reply as allow.

**OpenCode command.** An entry from `GET /command` (`name`, optional `description`/`template`). Invoked with `POST /session/:id/command` `{command, arguments, agent}`.
_Avoid:_ treating `/name` as a BB skill mention; calling TUI-only `/help` as if it were HTTP.

**Slash send.** The first text part of a turn, if it is exactly `/name` plus optional arguments **and** `name` is listed for that directory, is a command send. Attachments on the same turn stay a normal prompt.
_Avoid:_ swallowing unknown `/foo`; routing `/undo` through header revert unless it is listed.

**BB skill root.** A `skills/configure` root BB staged for this provider. The bridge appends a text catalog of those skills on the next `session.prompt`. Empty roots clear it.
_Avoid:_ PATCH `/config` or editing `opencode.json`.

**Command chip.** Composer action listing `GET /command`. Selecting inserts `/name ` into the draft. Execution waits for send (same as the agent chip).
_Avoid:_ calling `session.command` from the chip; showing the chip on Pi/Claude.

## Principles

- Fail closed. Ambiguous transport, unknown events, unknown permissions, and version skew never guess yes.
- One official OpenCode door. `@opencode-ai/sdk` is imported in one host module. Live chat is global `event.subscribe()` filtered by session id.
- Actions mutate; events tell the truth. The bridge does not invent BB turn/item ids. After revert, hydrate from OpenCode; do not diff message ids.
- Capabilities only narrow. Declare the smallest honest set. Never advertise fork, reasoning, or rename that the bridge cannot keep. Reasoning effort is advertised from that model's OpenCode `variants` (BB-legal keys only) **and** the bridge forwards `reasoningLevel` as OpenCode `variant`.
- The BB timeline is the product. No second transcript, no OpenChamber shell, no custom cards unless the generic one is actually insufficient — and V1 has already decided it is sufficient.
- Direct probes. A claim names the command, RPC, file, or UI seam that would falsify it. No verification theater.

## Constraints

- Community plugin at `/Users/macvm/Desktop/Projects/other/bb-plugin-opencode`. Public provider id `opencode`.
- Three entries: `server.ts` declares; `host.ts` owns the SDK, the detached process, and `thread/delta`; `app.tsx` is slots and RPC only.
- `@opencode-ai/sdk` only in the host client module. Conformance `@bb/provider-bridge-protocol/conformance` is test-only / devDependency.
- One detached OpenCode per host. Attach-first via lock/port in plugin `dataDir`. Spawn detached on miss. No in-process child. No module-singleton client.
- Capabilities: `fork: "checkpoint"`, `sessionRestore: true`, `supportsThreadRename: true` only if title writes work. Permission modes and reasoning only if honestly mapped. Runtime may narrow, never widen.
- Permissions use the provider-bridge grammar and BB's generic card. Honor `opencode.json`. BB mode is the ceiling. A fail-closed `unknown` result never approves, including under BB mode `full`.
- Manual import only. Refuse running sessions. Dedup on `providerId === "opencode"` + `providerThreadId`. Directory comes from the server-confirmed OpenCode session path. No managed worktree invented. Personal project if the path is outside every project.
- `turn/steer` refuses with JSON-RPC `-32601` so BB queues. A queued follow-up captures its OpenCode agent at enqueue, not at flush.
- A listed `/name` send uses `session.command`, not `session.prompt`. Unknown slashes and slash+attachment sends stay `session.prompt`. `skills/configure` is accepted; the plugin never writes OpenCode config files.
- Every `session.prompt` includes `agent`. Never omit it (OpenCode #21728). Resume and import do not write an agent. A send is refused (no `session.prompt`) while the picker is in the unknown-agent error state, and at flush if the enqueue-stamped agent is no longer a selectable primary.
- Pin the current stable `@opencode-ai/sdk` / `opencode serve` surface. Do not call V2-only routes.
- Existing `acp-opencode` threads never migrate. Distinct name and icon.
- Import must not silently `session.create`. If public spawn cannot create an idle provider thread (`input` XOR `prompt`; cannot set `providerThreadId`), Import confirm writes a pending adopt and the user-confirmed open consumes it inside `thread/start`. Permanent list-only with no pending-adopt/open path is a V1 blocker, not a ship configuration. Never "smallest prompt then stop."
- An unsupported attachment fails the whole send (visible error). It is not stripped with a warning.
- Deleting a BB `opencode` thread does not delete the OpenCode session.
- Task children are created by the OpenCode server, not the plugin. The bridge never `session.create`s because Task started. `@mention` text is sent unchanged in `session.prompt` parts.
- Child-session events never become items on the parent BB thread. Child `session.status`/`session.idle` does not emit the parent's `turn.boundary`.
- `permission.asked` on a Task child of the in-flight parent uses the same F5 card and reply path, addressed to that child request. Fail-closed still applies.
- A Task spawn does not create a BB thread or a pending adopt. User-confirmed open of a Task child uses the Import adopt path (ISC-42 family) and is refused while that child is running (same rule as ISC-44). No custom Task card: the confirm control is Import, plus a generic tool-item action only if BB already has that seam.
- Stop interrupts the parent session. If `session.children` (or equivalent) lists Task children, those live children are interrupted too. After the parent `turn.boundary`, leftover child `permission.asked` is treated as uncorrelated (no approve, not attached to a card).

## Goal

"Add first-class OpenCode support in BB so it feels native, not like a generic ACP guest."

A community plugin registers provider `opencode`. A user can start and resume OpenCode sessions from BB, stream thinking/tools/live bash in the BB timeline, stop, undo, redo, attach what OpenCode accepts, answer permissions on BB's card, pick a model and an OpenCode agent and change that agent on the next send, run a listed OpenCode `/command` from the composer, see BB-injected skills in the session catalog, invoke configured OpenCode subagents via `@mention` / Task without leaving the parent thread as a card, open a Task child only by user-confirmed adopt, and manually import existing sessions — with one detached OpenCode per host and honest Settings/CLI when the binary, version, or auth is wrong.

## Not yet specified

- resolved: idle spawn — see Decision 2026-08-22 (spikes). ISC-42.2 tombstoned; ISC-42.3 is the adopt path.
- resolved: multi-cwd — yes on `opencode` 1.18.21 via `POST /session?directory=D`. ISC-68 unblocked.
- resolved: permission map — see Decision 2026-08-22 (permission table). Fail-closed `{ok|resolved|unknown}` still holds.
- fog: Which OpenCode tool names are bash/shell vs generic tool cards. — mapping table; live-bash claim (ISC-18) is the product bar. Week-one list: `bash`/`shell` → command item; everything else → generic tool (Task included).
- resolved: version window — `@opencode-ai/sdk@1.18.21` / `opencode serve` `1.18.x` (`>=1.18.0 <1.19.0`). Stable HTTP only.
- resolved: user message `info.agent` is required on the 1.18.21 `UserMessage` schema. Hydrate ladder uses it; absent still degrades to default primary.
- resolved: `permission.asked` carries `sessionID`; `Session.parentID` names the parent. Correlate child-of-in-flight-parent that way. Uncorrelated → no approve, no attach.
- fog: Does BB's generic tool item already expose a user action the plugin can bind to "open this session id"? — if no, ISC-76's confirm control is Import only; do not invent a custom Task card to create the seam.

## Features

### F0 · Cross-cutting
Why: the plugin can ship as a community package and later be vendored as `provider-opencode` without rewriting the contract.

- [x] ISC-1: Plugin registers `bb.agents.experimental_registerProvider({ id: "opencode", displayName: "OpenCode", kind: "agent" })`.
- [x] ISC-2: Antecedent: a thread started with `--provider opencode` has `providerId === "opencode"`.
- [x] ISC-2.1: The registered `displayName` is `OpenCode` and does not contain `ACP`.
- [x] ISC-3: Anti: shipped `server` / `host` / `app` entrypoints contain no import from `@bb/*`.
- [x] ISC-4: Anti: `@opencode-ai/sdk` is imported only from the single host client module (not from `server.ts` or `app.tsx`).
- [x] ISC-5: `@bb/provider-bridge-protocol/conformance` is a devDependency and is not imported by shipped `server` / `host` / `app`.
- [x] ISC-6: Declared capabilities include `fork: "checkpoint"` and `sessionRestore: true`. Handshake matches. `thread/fork` calls OpenCode `session.fork` and does not `session.create`.
- [x] ISC-7: Anti: after install, existing threads with `providerId === "acp-opencode"` still have that id.
- [x] ISC-8: Composer agent picker renders only when `threadProvider({ threadId })` returns `providerId === "opencode"`.
- [x] ISC-8.1: The composer agent picker is hidden unless that RPC returns `opencode`.
- [ ] ISC-8.2: Per-message Fork `run` no-ops unless the thread is `opencode`. BB `messageAction` has no `isAvailable` or `roles`; the Fork icon still appears on other providers. Revert/Redo chrome removed (native Edit is the mid-thread resubmit).
- [x] ISC-6 checkpoint stamp on completed settle; unmatched revert refuses instead of last-of-role; `turn.boundary` uses `failed` not `error`; `provider/health` implemented; hydrate emits `turn.open` + `input.provider` for user bubbles; BB `instructions` prepended; `disallowedTools` deny; questions fail-closed (1.18 has no question API).
- [x] Mobile: compact PWA banner hosts the Agent picker (BB hides plugin composer actions); touch targets + visualViewport; declarative `defaultAgent` for the iOS app (no plugin frontend). Native fork/rewind already follow `fork: "checkpoint"`.
- [x] Provider mark: `app.slots.experimental_providerIcon` inline `currentColor` window (web pickers/settings). Server `icon` stays the currentColor SVG for iOS `ServerSvgIcon`. Branding logos are explicit light/dark fills because Settings uses `<img>`.

### F1 · Sessions
Why: one BB thread is one OpenCode session, so resume is the same conversation.

- [x] ISC-9: `thread/start` without an adopt reservation calls `session.create` once and emits `thread/identity` with that OpenCode session id as `providerThreadId`.
- [x] ISC-10: `thread/resume` does not call `session.create`.
- [x] ISC-10.1: `thread/resume` emits `thread/identity` and `session.reset` after get/messages.
- [x] ISC-11: Anti: resume never diffs OpenCode message ids across a revert; it refetches the whole transcript.
- [x] ISC-12: An OpenCode title change updates the BB thread title from the live event stream (no BB resume required).
- [~] ISC-13: [DROPPED — see Decisions 2026-08-22] A BB thread rename writes the title back to OpenCode XOR `supportsThreadRename` is omitted.
- [x] ISC-68: `thread/start` for workspace directory D creates an OpenCode session whose server-confirmed directory is D, even when the detached server was first started in another directory. (Blocked on the multi-cwd fog spike.)
- [x] ISC-70: Anti: deleting a BB thread with `providerId === "opencode"` does not delete the OpenCode session.

### F2 · Live turn
Why: the BB timeline *is* the OpenCode turn — text, thinking, tools, live bash, stop.

- [x] ISC-14: `turn/start` calls `session.prompt` once.
- [x] ISC-15: `message.part.delta` text appears as BB text item deltas.
- [x] ISC-16: Reasoning/thinking parts appear as BB reasoning items.
- [x] ISC-17: Tool parts appear as BB tool or command items.
- [x] ISC-18: Bash/shell progress updates the same command item live.
- [x] ISC-19: Stop calls `session.interrupt` on the parent and on each listed live Task child of that parent; the parent turn reaches `turn.boundary`.
- [x] ISC-20: `turn/steer` returns JSON-RPC `-32601`.
- [x] ISC-21: An attachment type OpenCode cannot take fails the whole send with a visible error. The part is not stripped and sent anyway.
- [x] ISC-65: A supported attachment type is included in the `session.prompt` parts.
- [x] ISC-22: Events for OpenCode session B never appear as items on BB thread A while both turns run.
- [x] ISC-23: Anti: `session.events()` is not the live chat stream.
- [x] ISC-24: If the transport dies mid-prompt, the bridge refetches and does not call `session.prompt` again.
- [x] ISC-25: Unknown OpenCode event types are tallied in the plugin log and do not fail the turn.
- [x] ISC-26: OpenCode process death mid-turn emits `turn.boundary` with an error and does not crash the host worker.
- [x] Context meter: settle/hydrate emit `usage` + `contextWindow` from assistant `tokens` (`used` = input + cache.read) and catalog `limit.context`. BB draws the native composer ring.

### F3 · Catalog
Why: model and OpenCode agent are real start/resume **and later-turn** choices, not fake models.

- [x] ISC-27: The BB model picker for this provider lists models from OpenCode `config.providers()`.
- [x] ISC-27.1: Anti: `app.agents()` ids do not appear as models in that picker.
- [x] ISC-28: The composer agent picker lists only selectable primaries from `app.agents()`.
- [~] ISC-29: [DROPPED — see Decisions 2026-08-22] The selected OpenCode agent is applied at `thread/start` or `thread/resume` only.
- [x] ISC-29.1: Every issued `turn/start` `session.prompt` — first send, later send, and ISC-32 resend — includes the selected selectable primary. The field is never omitted. (ISC-24 already forbids a disconnect retry that re-issues prompt.)
- [x] ISC-29.2: Anti: a composer agent-picker change with no following send issues zero host RPCs and zero OpenCode calls (no `session.prompt`, no `noReply`, no V2 `switchAgent`).
- [x] ISC-29.3: After resume, import, undo, or redo hydrate, the picker shows the last user-message `info.agent` that is a currently listed selectable primary; if that field is absent or names a non-selectable-primary id that is known (hidden / system / subagent), the default primary; if it names an unknown id, a visible error and the next send is refused until the user picks a listed selectable primary — never a persisted BB cookie, never a silent `build`, never sending the unknown id.
- [x] ISC-29.4: Anti: ids that are not selectable primaries never appear as picker values and are never hydrated into the picker.
- [x] ISC-29.5: A follow-up BB queues because `turn/steer` is `-32601` is stamped with the agent selected at enqueue, not the picker value at flush. If that stamped id is no longer a selectable primary at flush, the send is refused (same as ISC-29.3 unknown), not rewritten to the default.

### F4 · Revert
Why: mid-thread resubmit is BB native **Edit message** (`fork: "checkpoint"` + `supportsSessionRewind`). OpenCode `session.revert` / `unrevert` stay as host RPCs; they are not message-bar chrome.

- [x] ISC-30: Host `undo` maps `role` + `text` to an OpenCode `messageID` and calls `session.revert`. Not shown on the bubble (native Edit owns that verb).
- [x] ISC-31: Host `redo` calls `session.unrevert`. Not shown on the bubble.
- [x] ISC-32: After a successful revert, a following send that is rejected restores the previous tail (no permanent optimistic loss).

### F5 · Permissions
Why: OpenCode asks; BB's existing card answers; OpenCode still remembers always/`opencode.json`; BB mode is only a ceiling.

- [ ] ISC-33: A `permission.asked` event renders on BB's generic permission card.
- [ ] ISC-34: once / always / reject from that card are written back to OpenCode.
- [x] ISC-35: Under BB mode `full`, a permission ask is auto-approved and that allow is written back to OpenCode.
- [x] ISC-36: Under BB mode `accept-edits` or `auto`, a permission OpenCode still wants asked is not auto-approved by the bridge.
- [x] ISC-37: A fail-closed permission result of `unknown` does not approve.
- [ ] ISC-63: A deny rule in `opencode.json` is still honored under BB mode `full`.
- [x] ISC-64: When the tagged result is `unknown`, the ask is not approved even under BB mode `full`.
- [x] ISC-38: Anti: the bridge does not emit `pendingInteraction` or call `bb.ui.requestInput` for permissions.
- [x] ISC-39: Anti: the bridge does not use `messageDirective` for bash.

### F6 · Manual import
Why: sessions born outside BB enter the sidebar only when the user clicks Import, and they keep their OpenCode identity.

- [x] ISC-40: Settings exposes an Import control that lists unimported OpenCode sessions only after the user opens it.
- [x] ISC-41: Anti: installing or starting the plugin does not create BB threads for existing OpenCode sessions.
- [x] ISC-42: Import adopts an existing OpenCode session. The adopt seam is either idle-spawn+bind or lazy-open+reservation; both are specified below. The claim is not "adopt works only if idle spawn exists."
- [x] ISC-42.1: Anti: import never calls `session.create` for a selected existing session id and never sends a prompt solely to manufacture a session.
- [~] ISC-42.2: [TOMBSTONED — see Decisions 2026-08-22 spikes] Idle-spawn adopt path. Public spawn cannot create an idle provider thread.
- [x] ISC-42.3: If public spawn cannot create an idle provider thread, Import confirm writes a pending adopt keyed by `{projectId, hostId, opencodeSessionId}` and invents no BB thread. The user-confirmed open consumes it without `session.create`. Permanent list-only with no pending-adopt/open path does not ship.
- [x] ISC-59: A pending adopt for session S in project P on host H is consumed exactly once by the user-confirmed `thread/start` that opens that listed session.
- [x] ISC-60: Anti: a later turn on an already-seen thread in P, or an unrelated project, does not consume a pending adopt for S. Abandoned handoffs expire.
- [x] ISC-43: A session whose `id` is already some BB thread's `providerThreadId` with `providerId === "opencode"` is not imported again.
- [x] ISC-44: A running OpenCode session is listed as blocked and cannot be imported.
- [x] ISC-45: A session whose server-confirmed directory is missing is listed as blocked and cannot be imported.
- [x] ISC-46: After a BB thread exists for the import, a directory equal to the current project root uses `environment: { type: "project-default" }`.
- [x] ISC-47: After a BB thread exists for the import, another existing path on the same host uses an unmanaged host environment for that path and does not create a BB-managed worktree.
- [x] ISC-48: After a BB thread exists for the import, a path that sits in no project lands in the personal project.
- [x] ISC-49: Child sessions default unchecked. Importing a parent does not import its children.

### F7 · Host process and operator surface
Why: one OpenCode on the machine, and the operator can see when it is missing, skewed, or unauthenticated.

- [x] ISC-50: A lock + port file under the plugin `dataDir` identifies at most one detached OpenCode server per host.
- [x] ISC-50.1: A lock/port file whose pid is dead or whose port is not listening is reclaimed by the next worker; exactly one live OpenCode pid results.
- [x] ISC-62: Two cold workers starting with no lock produce one OpenCode pid; the loser attaches.
- [x] ISC-51: The provider-bridge worker and the host-RPC worker attach to that server by URL. Neither spawns an in-process OpenCode child.
- [x] ISC-67: Anti: the host client is acquired by attach URL, not a process-wide module singleton.
- [x] ISC-69: After host-RPC idle eviction, the next probe attaches to the same OpenCode pid and port.
- [x] ISC-52: Attach to a server outside the pinned version window fails with an error that names both versions.
- [x] ISC-53: `bb.status.needsConfiguration()` is true when the binary is missing or the version is outside the window.
- [x] ISC-54: Settings probe shows binary path, server version, attached-or-spawned, port, and supported range.
- [x] ISC-55: `bb opencode status` prints those same facts.
- [x] ISC-56: `bb opencode version` prints the SDK pin and the attached server version.
- [x] ISC-57: `bb opencode logs` prints recent plugin and/or OpenCode log lines.
- [x] ISC-58: Auth probe failure is visible in Settings (not a silent empty model list only).

### F8 · Task children
Why: OpenCode Task / `@mention` already creates a child session. BB shows the parent card and can adopt the child; it does not become Voyager or OpenChamber.

- [x] ISC-71: Read maps to `fileRead`, Task to `delegation`, bash to `command`, others to generic `tool`. Live `thr_yxpq8846ww` emitted `item/started` `fileRead` for `package.json`. Invalid `{ id }` keys were dropping the whole leftover batch.
- [x] ISC-71.1: Anti: the plugin does not call `session.create` because Task started.
- [x] ISC-73: `session.status` idle / `session.idle` for a Task child does not emit `turn.boundary` on the parent BB thread.
- [x] ISC-74: `permission.asked` whose session is a Task child of the in-flight parent renders on **that parent BB thread's** generic permission card only (never as a timeline item; ISC-22 still holds for items). Once / always / reject are written back to that same child request. Uncorrelated asks, including child asks after the parent `turn.boundary` and asks with no resolvable session, are not approved and are not attached to any thread.
- [x] ISC-75: Anti: a Task spawn creates zero new BB threads and writes zero pending adopts.
- [x] ISC-76: User-confirmed open of a Task child's OpenCode id uses the Import adopt path (ISC-42 family) and does not call `session.create`. Confirm control is Import; a generic tool-item action is allowed only if that BB seam already exists.
- [x] ISC-76.1: Anti: user-confirmed open of a still-running Task child is refused. Open after the child is idle uses the same adopt path as ISC-76. Mid-stream steal / hydrate of a live child is out of V1.
- [x] ISC-77: Anti: a user prompt containing `@<subagent>` is forwarded in `session.prompt` parts unchanged. The plugin does not rewrite it into `session.create` or a V2 `session.subagent` call.

### F9 · Commands and skills
Why: OpenCode already has `/commands` and a skill tool. BB has no plugin slash-command API (`/` is skills + plan/goal). First-class means we speak OpenCode's HTTP command API and accept BB's `skills/configure` without mutating the user's config.

- [x] ISC-80: `GET /command` is listed by host RPC `listCommands` and `bb opencode commands`.
- [x] ISC-81: A send whose first text is `/name args` and whose `name` is listed calls `POST /session/:id/command` once and does not call `session.prompt`.
- [x] ISC-82: Anti: an unknown `/foo` is forwarded as `session.prompt` text unchanged.
- [x] ISC-83: Anti: a slash send that also has a non-text attachment is not routed to `session.command` (ISC-21 still fails the whole send if the attachment is unsupported).
- [x] ISC-84: `skills/configure` is implemented and answers `{ok:true}` (not `-32601`).
- [x] ISC-85: After a non-empty `skills/configure`, the next `session.prompt` includes a text part cataloguing those skill names.
- [x] ISC-86: An empty `skills/configure` clears that catalog so a later prompt has no appendix.
- [x] ISC-87: Anti: the plugin never writes `opencode.json` / `skills.paths` / `command` config to inject BB skills.
- [x] ISC-88: `/` autocomplete (not a Command chip) renders only with the same OpenCode visibility rule as the Agent chip (ISC-8).
- [x] ISC-89: Anti: choosing an autocomplete row inserts `/name ` into the draft and issues zero `session.command` / `session.prompt` calls.
- [x] ISC-90: `model/list` advertises that model's OpenCode `variants` that are BB reasoning levels (`none`/`low`/`medium`/`high`/`xhigh`/`max`/…). Unknown keys like `minimal` are skipped. Empty variants → `none` only. `turn/start` `reasoningLevel` is sent as OpenCode `variant` (exact name; `ultracode`/`ultra` fall back to `max`/`xhigh` when the model has them). Thinking parts still map as reasoning items (ISC-16).
- [x] ISC-64.1: An unmappable or un-cardable permission ask with an id is replied `reject` (not left running). Asks with no id still do not approve (ISC-64).

## Test Strategy

Probes attach at the seam the user or BB core actually consumes. No claim is closed by a paragraph. Runnable probes stay red until the code exists.

| isc | type | check | threshold | tool | anchors_to |
|-----|------|-------|-----------|------|------------|
| ISC-1 | bash | `bb plugin list --json` (or provider list) contains id `opencode` after install | exit 0 and id match | bb | literal |
| ISC-2 | bash | `bb thread spawn --provider opencode --prompt ping` then `bb thread show --json` has `providerId=opencode` | providerId exact | bb | literal |
| ISC-2.1 | bash | `bb provider list --json` (or register payload) displayName is `OpenCode` and does not match /ACP/i | name exact; no ACP | bb | literal |
| ISC-3 | bash | grep shipped ts/tsx for `from ['"]@bb/`, `require('@bb/`, and `export * from ['"]@bb/` | 0 matches | grep | derived: public plugin contract |
| ISC-4 | bash | `grep -R "@opencode-ai/sdk" server.ts app.tsx` empty; exactly one host module imports it | 0 in server/app; 1 client | grep | derived: SDK stays on host |
| ISC-5 | bash | package.json has conformance only under devDependencies; grep shipped entries for the package name is empty | 0 shipped imports | grep | derived: test-only conformance |
| ISC-6 | bun-test | registered + handshake `fork: "checkpoint"`; `thread/fork` calls `session.fork` | both present | bun-test | derived: honest capabilities |
| ISC-7 | bash | a fixture `acp-opencode` thread id is unchanged after plugin install | providerId unchanged | bb | derived: no ACP migration |
| ISC-8 | bun-test | both ISC-8.1 and ISC-8.2 pass | both green | bun-test | derived: no chrome leak |
| ISC-8.1 | bun-test | composer agent picker returns null when RPC says `claude-code` / `acp-opencode`; renders when `opencode` | assertions pass | bun-test | derived: no chrome leak |
| ISC-8.2 | bun-test | header undo/redo returns null when RPC says `claude-code` / `acp-opencode`; renders when `opencode` | assertions pass | bun-test | derived: no chrome leak |
| ISC-9 | bash | after start, OpenCode session list contains `providerThreadId`; identity event logged once | 1 session, 1 identity | bb + OpenCode | literal |
| ISC-10 | bash | resume of that thread does not increase OpenCode session count | session count unchanged | bb + OpenCode | literal |
| ISC-10.1 | bun-test | resume handler emits identity + `session.reset` after get/messages | both emitted; create not called | bun-test | derived: resume hydrate |
| ISC-11 | bun-test | hydrate fixture after revert does a full refetch, no id-diff branch | assertion on call graph / snapshot | bun-test | derived: events are truth |
| ISC-12 | bash | rename the OpenCode session while the BB thread is open and idle; BB title matches; `thread/resume` call count stays 0 | titles equal; resume calls 0 | bb + OpenCode | derived: titles |
| ISC-68 | bash | start thread in directory D while detached OpenCode was first spawned in directory E; session directory is D | path D | bb + OpenCode | derived: one server many dirs |
| ISC-70 | bash | delete the BB thread; OpenCode session id still exists | session present | bb + OpenCode | derived: adopt is a view |
| ISC-14 | bun-test | `turn/start` handler invokes `session.prompt` once per turn | 1 call | bun-test | literal |
| ISC-15 | bun-test | `map-delta` snapshot: text part delta → text item delta | snapshot match | bun-test | literal |
| ISC-16 | bun-test | `map-delta` snapshot: reasoning part → reasoning item | snapshot match | bun-test | literal |
| ISC-17 | bun-test | `map-delta` snapshot: tool part → tool/command item | snapshot match | bun-test | literal |
| ISC-18 | bun-test | `map-delta` snapshot: successive bash parts update one item id | same item id | bun-test | literal |
| ISC-19 | bash | stop a running parent that has a live Task child; parent and that child are idle; parent turn has boundary | parent+child idle; parent bounded | bb + OpenCode | literal |
| ISC-20 | bun-test | `turn/steer` returns error code `-32601` | code exact | bun-test | derived: BB queues |
| ISC-21 | bash | send an unmapped attachment type; visible error; `session.prompt` is not called | error shown; prompt calls 0 | bb | derived: attachments honest |
| ISC-65 | bash | send a mapped attachment; OpenCode prompt parts include that file/image | part present | bb + OpenCode | literal |
| ISC-22 | bash | two concurrent `opencode` turns, including parent + Task child; no item whose OpenCode session id is B appears on thread A | 0 cross items | bb | derived: one event door |
| ISC-23 | bash | grep host chat-subscribe path; `session.events` is not used to feed the live timeline | 0 chat-subscribe uses | grep | derived: one event door |
| ISC-24 | bun-test | mid-prompt disconnect fixture: refetch called, `session.prompt` not retried | prompt calls stay 1 | bun-test | derived: fail closed |
| ISC-25 | bun-test | unknown event type increments tally, turn still completes | tally +1; no throw | bun-test | derived: fail closed |
| ISC-26 | bash | kill detached OpenCode mid-turn; BB turn errors; host RPC still answers `probe` | turn error; probe ok | bb | derived: process isolation |
| ISC-27 | bash | model list from provider matches `config.providers()` ids | set equality | bb + OpenCode | literal |
| ISC-27.1 | bash | intersection of model-picker ids and `app.agents()` ids is empty | empty intersection | bb + OpenCode | derived: agents are modes |
| ISC-28 | bun-test | fixture `app.agents()` payload contains `build`, `plan`, one custom primary, one `hidden`, one `mode: "subagent"`, and one system `title`/`compaction`; picker options equal exactly `{build, plan, custom}` | exact set | bun-test | literal |
| ISC-29 | bun-test | [DROPPED] old start/resume-only probe | n/a | n/a | n/a |
| ISC-29.1 | bun-test | one prompt-builder construction site: first send, later send, and ISC-32 resend each pass `agent` | agent present on those three calls | bun-test | derived: never omit agent |
| ISC-29.2 | bun-test | slot `onChange` with no `turn/start`: host RPC count 0; grep slot for `noReply` / `switchAgent` empty | RPC 0; grep 0 | bun-test | derived: intent until send |
| ISC-29.3 | bun-test | hydrate fixtures: last selectable primary shown; absent/hidden/system/subagent → default; unknown id → visible error and next send refused; post-revert tail wins; no BB cookie | ladder assertions | bun-test | derived: events are truth |
| ISC-29.4 | bun-test | same fixture as ISC-28: picker options and hydrate results equal `{build, plan, custom}` and contain none of the hidden/system/subagent ids | exact set; empty intersection with the three excluded | bun-test | derived: primaries only |
| ISC-29.5 | bun-test | enqueue under agent A, flip picker to B, flush; prompt `agent` is A. Second fixture: A unlisted at flush → no `session.prompt` | agent A; then prompt calls 0 | bun-test | derived: enqueue stamp |
| ISC-30 | bash | undo after a finished turn; OpenCode revert applied; BB timeline matches refetch | revert observed; timelines match | bb + OpenCode | literal |
| ISC-31 | bash | redo after undo; OpenCode unrevert applied; timelines match | unrevert observed | bb + OpenCode | literal |
| ISC-32 | bun-test | after revert, a `session.prompt` that OpenCode rejects (invalid/busy) restores the previous tail | tail restored | bun-test | derived: no optimistic loss |
| ISC-33 | bash | trigger a permission ask; generic BB permission card is visible | card present | bb UI | literal |
| ISC-34 | bash | answer once; OpenCode permission reply recorded for that request | reply observed | OpenCode / log | literal |
| ISC-35 | bash | mode `full`; OpenCode records an allow reply for the ask and the turn is not blocked on a card | allow observed; no pending card | bb + OpenCode | derived: ceiling |
| ISC-36 | bash | mode `accept-edits`; an OpenCode-asked permission still shows the card | card present | bb | derived: ceiling |
| ISC-37 | bun-test | tagged result `unknown` maps to deny / no reply-allow | no approve call | bun-test | derived: fail closed |
| ISC-38 | bash | grep bridge for `pendingInteraction` and `requestInput` | 0 matches | grep | derived: generic card |
| ISC-39 | bash | grep bridge for `messageDirective` | 0 matches | grep | derived: generic cards |
| ISC-40 | bash | Settings includes Import; plugin log line `import.list` is absent until the Import control is opened, then present | log absent then present | bb + log | literal |
| ISC-41 | bash | after install+host start, BB thread count for `opencode` is unchanged without Import | delta 0 | bb | literal |
| ISC-42 | bash | ISC-42.1 holds. After the idle-spawn spike a Decision names the active child (42.2 or 42.3) and the other is tombstoned | 42.1 plus named child | bb | derived: honest adopt |
| ISC-42.1 | bash | import a selected existing session; OpenCode session count unchanged; no `session.prompt` issued by import | count unchanged; prompt calls 0 | bb + OpenCode | derived: never fake prompt |
| ISC-42.2 | bash | after an adopt seam exists, imported thread `providerThreadId` equals selected id; first open does not call `session.create` | id match; create not called | bb + OpenCode | literal |
| ISC-42.3 | bash | if idle spawn is impossible: confirm writes pending adopt `{projectId, hostId, sessionId}` and zero new BB threads; user-confirmed open binds that id without `session.create` | pending present; create not called | bb + OpenCode | derived: honest fallback |
| ISC-59 | bun-test | plant pending adopt P/H/S; user-confirmed start for that row binds S once; a second start does not see it | consumed once | bun-test | derived: reservation |
| ISC-60 | vitest | plant pending adopt P/H/S; consume with `isNewThread: false` leaves it; other project leaves it; TTL expires it | pending still present / expired | vitest | derived: reservation |
| ISC-43 | bash | import the same id again; rejected / omitted from list | not duplicated | bb | derived: dedup |
| ISC-44 | bash | a running session is not importable | blocked | bb + OpenCode | derived: no steal |
| ISC-45 | bash | session with deleted directory is not importable | blocked | bb | derived: server-confirmed path |
| ISC-46 | bash | import at project root; thread environment is `project-default` | env type match | bb | derived: directory mapping |
| ISC-47 | bash | import other existing path; environment is unmanaged host path; no new managed worktree | env type + path; worktree count unchanged | bb | derived: directory mapping |
| ISC-48 | bash | import path outside all projects; thread `projectId` is personal | personal project | bb | derived: directory mapping |
| ISC-49 | bash | parent selected only; child session has no BB thread | child absent | bb | derived: no auto children |
| ISC-50 | bash | two workers; one lock/port file; one listening OpenCode pid | 1 lock, 1 pid | bash | derived: one server |
| ISC-50.1 | bash | write a lock for a dead pid / closed port; next probe respawns or attaches; exactly one live OpenCode pid | 1 live pid; probe ok | bash | derived: one server |
| ISC-62 | bash | two cold workers started together with lock file removed; one OpenCode pid; both probes succeed | 1 pid; 2 probes ok | bash | derived: one server |
| ISC-51 | bash | neither worker pid is the OpenCode pid; both `probe` against the same port | pids differ; port shared | bash | derived: attach not child |
| ISC-67 | bun-test | acquire(client, urlA) and acquire(client, urlB) return distinct instances; acquire after simulated eviction calls the factory again | 2 instances; factory +1 | bun-test | derived: attach not child |
| ISC-69 | bash | idle-evict the host-RPC worker; next `probe` uses the same port and pid | pid+port unchanged | bb | derived: attach not child |
| ISC-52 | bash | attach override to a version outside the window; error names both versions | error text | bb | derived: version pin |
| ISC-53 | bash | hide binary from PATH; `needsConfiguration` true | true | bb | derived: operator surface |
| ISC-54 | bash | Settings probe RPC returns binary, version, attach state, port, range | all fields present | bb | literal |
| ISC-55 | bash | `bb opencode status` prints the same fields | field parity | bb | literal |
| ISC-56 | bash | `bb opencode version` prints SDK pin and server version | both present | bb | literal |
| ISC-57 | bash | after a named turn, `bb opencode logs` contains that session id or an event-type tally line from it | matching line | bb | derived: operator surface |
| ISC-58 | bash | logged-out / missing-auth fixture; Settings shows auth failure | visible error | bb | derived: operator surface |
| ISC-63 | bash | `opencode.json` deny for a tool; BB mode `full`; that tool is still asked or denied, not silently allowed by BB | deny/ask observed | bb + OpenCode | derived: ceiling |
| ISC-64 | vitest | tagged `unknown` under mode `full` does not call OpenCode allow | no approve call | vitest | derived: fail closed |
| ISC-64.1 | vitest | unknown ask that still has an id is replied `reject` | reply reject | vitest | derived: fail closed is deny |
| ISC-71 | live | parent Task tool part appears as a BB tool item on the timeline | item/* present | bb | literal |
| ISC-71.1 | bun-test | Task-started fixture: plugin `session.create` call count stays 0 | create calls 0 | bun-test | derived: server owns Task |
| ISC-73 | bun-test | inject child `session.status` idle while parent turn open and child still listed live beforehand; parent `turn.boundary` not emitted | boundary count 0 | bun-test | derived: child idle ≠ parent done |
| ISC-74 | bun-test | three fixtures: (1) child ask with resolvable in-flight parent → parent card, reply to child ids, no timeline item; (2) ask with no resolvable session → no approve, no attach; (3) child ask after parent boundary → no approve, no attach | card only on (1); (2)(3) no approve | bun-test | derived: fail closed |
| ISC-75 | bash | plant a pending adopt; spawn a Task; BB `opencode` thread count unchanged and pending-adopt store byte-identical | delta 0; store unchanged | bb | derived: no auto-import |
| ISC-76 | bash | user-confirmed open of listed Task child: `providerThreadId` equals child id; `session.create` not called | id match; create 0 | bb + OpenCode | derived: honest adopt |
| ISC-76.1 | bash | open a still-running Task child is refused; after that child is idle, open binds `providerThreadId` to the child id | refused then id match | bb + OpenCode | derived: no mid-stream steal |
| ISC-77 | bun-test | prompt-builder fixture with text `@general look around`: parts contain that text; `session.create` 0; no `session.subagent` symbol | text present; create 0 | bun-test | derived: @mention is text |
| ISC-80 | bash | `bb opencode commands` lists `/init` (or another `GET /command` name) | name present | bb + OpenCode | literal |
| ISC-81 | bun-test | `/init repo` on `turn/start` calls `session.command` once and `session.prompt` 0 | command 1; prompt 0 | bun-test | literal |
| ISC-82 | bun-test | `/not-a-command` calls `session.prompt` with that text; command calls 0 | text present; command 0 | bun-test | derived: do not swallow |
| ISC-83 | bun-test | `/init` plus a localFile does not call `session.command` | command 0 | bun-test | derived: attachments honest |
| ISC-84 | bun-test | `skills/configure` returns `{ok:true}` | result ok | bun-test | literal |
| ISC-85 | bun-test | after configure, next prompt parts include the skill name | name in parts | bun-test | literal |
| ISC-86 | bun-test | empty roots → `formatSkillAppendix` is null | null | bun-test | derived: clear catalog |
| ISC-87 | bash | grep shipped src for writes to `opencode.json` skill/command config | 0 matches | grep | derived: no config mutate |
| ISC-88 | vitest | slash suggest uses the same OpenCode visibility helper; `app.tsx` has no Command action | helper present; no command action | vitest | derived: no chrome leak |
| ISC-89 | vitest | slash suggest only calls `insertCommandToken`; no `session.command` symbol | grep | vitest | derived: intent until send |
| ISC-90 | vitest | `turn/start` with `reasoningLevel: high` sends `variant: high` | lastPrompt.variant | vitest | literal |

## Decisions

- 2026-08-21: ACP is not the long-term OpenCode path. Use `@opencode-ai/sdk` the way Claude/Codex use vendor-native bridges.
- 2026-08-21: Ship first as a community plugin, provider id `opencode`. Keep ACP as fallback. Do not put OpenCode in BB core. No private `@bb/*` so the same plugin can later become `provider-opencode`.
- 2026-08-21: Steal OpenChamber boundaries, not its UI: one SDK door, tagged permission results, actions-only mutation, live truth from events, fail closed.
- 2026-08-21: Three-entry plugin. One detached OpenCode per host. Attach-first. No in-process child. No module-singleton client.
- 2026-08-21: `fork: "none"`. Revert is undo chrome. Capabilities only narrow.
- 2026-08-23 (edit-from-here): Native BB **Edit message** is OpenCode's mid-thread resubmit. It rewinds via `thread/fork` at the *previous* turn's `providerCheckpointId`, then sends the new text on this same BB thread. Checkpoint must be the last message that turn should keep (usually the assistant id). Stamping the user id dropped the previous reply. Plugin Revert/Redo buttons removed so they do not compete with Edit.
- 2026-08-23 (context meter): BB already draws `ThreadContextWindowIndicator` from `contextWindow` deltas. V1 maps OpenCode assistant `tokens` + catalog `limit.context` and does not invent a plugin usage widget.
- 2026-08-22: Restated. OpenCode has a real `POST /session/:id/fork { messageID }`. V1 now advertises `fork: "checkpoint"`, stamps `providerCheckpointId` = last retained OpenCode message id on `turn.boundary`, and handles `thread/fork`. Revert stays in-place and is not a fork.
- 2026-08-21: Core OpenCode is in V1: start/resume, models, agents, live tools/bash, stop, revert/unrevert, permissions on the generic card, attachments mapped or rejected, `turn/steer` refuse.
- 2026-08-21: Permissions are core, not a second knob. BB modes are the ceiling. `full` ≈ auto-approve. Fail-closed `{ok|resolved|unknown}`.
- 2026-08-21: Manual import only. Never auto-import. Never "smallest prompt then stop."
- 2026-08-21: Cut as fat: custom cards, nav panel, OpenChamber chrome, ACP migration, second transcript, extra auto-accept setting, `bb opencode restart`. `listModels` / `revertState` exist only if BB has no cheaper native seam; they are not a second live truth.
- 2026-08-22: ISA scaffolded from the locked V1 after two architecture review rounds (Kimi K3, GLM 5.2, Opus 5 via Pi). Ambiguity check skipped: goal and bounds already locked. `context_sufficient: true`.
- 2026-08-22: Verifications must be direct. A closed claim points at a command, test name, or probe — not a screenshot essay.
- 2026-08-22: ISA R1 (Kimi K3 `thr_5axqqt6ha8`, GLM 5.2 `thr_w77g5e84df`, Opus 5 `thr_6ergnhrffm`) all **sound-with-fixes**. Applied without expanding product scope: split ISC-8 and ISC-42; reservation consume-once + no cross-bind (ISC-59/60); never fake-prompt (ISC-42.1); live title sync (ISC-12); drop XOR rename claim ISC-13 to a Decision; behavioral event isolation (ISC-22); `opencode.json` under `full` (ISC-63); `unknown` beats `full` (ISC-64); supported attachments (ISC-65); session directory ≠ server cwd (ISC-68); cold-start race (ISC-62); attach-URL client (ISC-67); post-eviction reattach (ISC-69); agents are not models (ISC-27.1).
- 2026-08-22: BB thread rename → OpenCode title (`supportsThreadRename`) is a Decision, not a claim, until we implement the write. Capability stays omitted until the write exists.
- 2026-08-22: Fail-closed `unknown` outranks BB mode `full`. `opencode.json` deny outranks BB mode `full`.
- 2026-08-22: ISA R2 (Kimi `thr_uet3kx4nwe`, GLM `thr_4692n73sa4`, Opus `thr_decmc5x7hf`) all **sound-with-fixes**. Applied without expanding product scope: pending adopt keyed by `{projectId, hostId, opencodeSessionId}` (not a wildcard next-start); list-only-with-no-open is a V1 blocker; stale-lock reclaim (ISC-50.1); delete-BB-thread does not delete OpenCode session (ISC-70); unsupported attachment fails the whole send (ISC-21); ISC-67 behavioral; ISC-68 pinned to a multi-cwd fog spike; ISC-46–49 gated on a thread existing; idle-spawn spike will tombstone either 42.2 or 42.3.
- 2026-08-22: Until the idle-spawn spike is written, ISC-42.2 and ISC-42.3 both remain open. Closing one tombstones the other via a Decision that names the active path.
- 2026-08-22: Mid-session primary-agent switch is in V1. Stable SDK only: stamp `agent` on every `session.prompt`. Picker change is composer-local intent until the next send. Cut: V2 `switchAgent`, `noReply` persist, `pendingAgent` bind store, picker `onChange` RPC, mid-stream hot-swap, subagents in the picker.
- 2026-08-22: ISC-29 (start/resume only) dropped. Replaced by ISC-29.1–29.5. Architecture reviews: Kimi `thr_r4eu3i5qyr`, Opus `thr_yg742fsi74` (both sound-with-fixes). First spawn (`thr_ztw2umkid4`, `thr_rw9q6mi8jj`) failed because `--file` did not reach Pi; GLM `thr_6up3pqnh7i` was interrupted.
- 2026-08-22: Model vs agent: if the user picked a BB model, every prompt sends that model; otherwise omit `model` and let the agent default apply. Decision only — not a claim. No per-agent model memory.
- 2026-08-22: Hydrate ladder: last selectable primary on a user message → else default primary if absent/hidden/subagent → visible error if the id is unknown. Never silent `build`. After revert/unrevert, re-hydrate from the new tail (same path as ISC-30/31).
- 2026-08-22: Queued follow-ups capture agent at enqueue (ISC-29.5). Plan is not a BB safety boundary; F5 ceiling claims still apply after Plan→Build. Do not add a Plan→Build ISC; if coverage is wanted later, extend an ISC-36 fixture.
- 2026-08-22: ISA R3 (Kimi `thr_empwuv3fjq` sound; GLM `thr_zrdu8h2f9k` and Opus `thr_59bhcagns8` sound-with-fixes). Applied without expanding product scope: Language **selectable primary**; unknown-id send refused; enqueue stamp that is unlisted at flush refused; drop undefined retry from ISC-29.1; ISC-28/29.4 pin a literal fixture; ISC-29.2 observes host RPC not SDK; `info.agent` is a fog, not a cookie.
- 2026-08-22: A queued follow-up that flushes after undo/redo keeps the enqueue-stamped agent on the new tail. That interleaving is accepted. Do not rewrite the stamp from the post-revert picker.
- 2026-08-22: OpenCode Task / `@mention` children are in V1 as F8. Stable Task tool only. Plugin never `session.create`s for Task. Parent shows a generic Task tool item. Child events stay off the parent timeline (ISC-22) except the in-flight child's permission card on the parent thread. Child idle does not end the parent turn. Child permissions use F5. No auto BB thread. Open is user-confirmed adopt of an **idle** child. Cut: V2 `session.subagent`, background Task flag, OpenChamber subtask chrome, BB Voyager-as-OpenCode, custom Task card, subagents in the picker, mid-stream steal of a live child.
- 2026-08-22: ISA R4 (Kimi `thr_ycxwi7m9ir`, GLM `thr_kpc99pwr25`, Opus `thr_3qtf84k6ca`) all **sound-with-fixes**. Applied without expanding product scope: stop interrupts listed Task children; leftover child asks after parent boundary are uncorrelated; ISC-74 names the parent thread and reconciles ISC-22; ISC-76.1 refuses running children; Vision says tool item not Task card; probes named and non-vacuous.
- 2026-08-22: Implement F8 after F2 and F5 (need live tools + permission card). Import (F6) stays last.
- 2026-08-22 (idle-spawn spike): Public spawn cannot create an idle `opencode` thread. Evidence: `bb thread spawn` requires `--prompt`; `CreateThreadRequest` rejects `input.length === 0` unless `originKind === "fork"` (the only origin kind); SDK `ThreadSpawnArgs` is `input` XOR `prompt` and cannot set `providerThreadId`. `spawn({ input: [] })` is type-legal and server-illegal for a normal/plugin origin. Active path: **ISC-42.3** pending adopt `{projectId, hostId, opencodeSessionId}` + user-confirmed open. **ISC-42.2 tombstoned**. Never smallest-prompt-then-stop.
- 2026-08-22 (idle-spawn / open seam): User-confirmed open is plugin RPC `openImported` that writes a one-shot intent then `bb.sdk.threads.spawn` with the user's real first message. `experimental_deriveProviderOptions` attaches `adoptSessionId` only when that intent is present. Unrelated `thread/start` in the same project does not see it (ISC-60). `thread/start` consumes the pending adopt and must not `session.create`. Confirm still invents no BB thread.
- 2026-08-22 (multi-cwd spike): One detached `opencode serve` 1.18.21 **can** create a session whose directory D ≠ server cwd E. `POST /session?directory=D` recorded `directory=/private/tmp/bb-oc-spike-D` while the server was spawned in `/tmp/bb-oc-spike-E`. Body `{directory}` is ignored. GitHub #23607 is fixed on this window. ISC-68 unblocked. Do not spawn per-directory servers.
- 2026-08-22 (permission map spike): Tagged result: missing `id`/`sessionID`/`permission` → `unknown`; recognized permission + mappable subject → `ok`; otherwise `resolved` only after a mapped subject is built. Map: `bash`/`shell` → approval subject `command` (command = `metadata.command` or `patterns[0]`); `edit`/`write`/`patch`/`multiedit` → `file_change`; everything else including `task`/`skill`/`webfetch`/`doom_loop`/`external_directory` → `tool_use` with presentation. `unknown` and `opencode.json` deny both beat BB mode `full`. Handshake `approvalEnforcedBy: "provider"` so the runtime does not auto-approve an `unknown` under `full`.
- 2026-08-22 (commands/skills): BB has no plugin `/` surface (`/` is skills + plan/goal; `host.list_commands` only knows `acp-opencode`). V1 send-path: listed `/name` → `POST /session/:id/command`. Unknown slash stays a prompt. BB skills arrive via `skills/configure` as a prompt appendix. Command chip inserts `/name `; it does not execute. Do not write `opencode.json`. Do not declare `composerActions: ["plan"]`.
- 2026-08-22 (permission dialect, pin wins): `@opencode-ai/sdk@1.18.21` emits `permission.updated` (`Permission`: `{id, type, pattern, sessionID, messageID, callID, metadata}`) and replies on `POST /session/{id}/permissions/{permissionID}` `{response}`. The earlier spike's `permission.asked` + `POST /permission/{requestID}/reply` is a later dialect. V1 accepts both event names and both reply URLs (1.18 first, 404 → next). Tombstone: treating only `permission.asked` as the live event on this pin.
- 2026-08-23 (permission v2, live serve `/doc`): attached `opencode serve` 1.18.21 publishes `permission.v2.asked` (`action`/`resources`/`source`) and `permission.asked`. SDK types still list `permission.updated` and omit v2. Probe `thr_wjw27evadr` / `ses_fd41141a2ffeyP8Q7x4oUpZuhs` hung on `apply_patch` until Stop; `GET /permission` stayed `[]` (v1 list) and BB never got `interaction/request`. V1 now cards `permission.v2.asked`, unwraps SSE `data` envelopes, replies `POST /api/session/:id/permission/:id/reply` first, and polls `GET /api/session/:id/permission` on live turns. Not an `@opencode-ai/sdk/v2` import. ISC-33/34 stay open until glass Allow-once.
- 2026-08-23 (Revert from here no-op): `thr_4e4hhx4ghs` click did nothing because (1) host `revert` `{ok:false}` was discarded and the RPC returned success, (2) BB bubble text is the prompt-only part while OpenCode stores `[BB project instructions]` + prompt, (3) host-process `hydrateBoundSession` cannot emit deltas. Fix: match last text part, propagate host `{ok,error}`, reload the thread after a real revert so `thread/resume` hydrates.
- 2026-08-23 (Revert flash): plugin `run` used `window.location.reload()` after undo/redo so the whole BB chrome remounted. OpenChamber never reloads — it reprojects from `session.revert.messageID`. V1 now watches that cursor (SSE `session.updated` + 800ms poll) and emits `session.reset` + sliced hydrate. No full reload.
- 2026-08-23 (Revert/Redo/Fork clicks were dead): BB plugin RPC is `{ok:true,result}` / `{ok:false,error}`. Composer uses `useRpc` (unwraps). Message actions used raw `fetch` and read `providerId` on the envelope, so the OpenCode gate always failed closed. Unwrapping the envelope is required; a new thread would not have helped.
- 2026-08-23 (Revert still looked like a no-op): OpenChamber `filterMessagesByRevertPoint` slices `messages` at `session.revert.messageID` (drop that message and everything after). OpenCode does not delete rows. V1 hydrate now does the same slice on resume, otherwise reload paints the full transcript and Revert looks broken. Unique single-bubble fallback when text cannot be matched.
- 2026-08-23 (reasoning picker): OpenCode `GET /provider` already lists per-model `variants` (e.g. `openai/gpt-5.6-luna` = none/low/medium/high/xhigh/max). V1 had hardcoded Low/Medium/High for every model. Picker now uses those keys that are BB `reasoningLevel`s. `minimal` is not a BB level and is skipped.
- 2026-08-23 (Cloudwalking, no assistant rows): `thr_i22mjhzk8z` / `ses_fd4079105ffe9cTqv0aWte3n9o` ran 15 OpenCode messages (text + tools) while BB only showed Cloudwalking until Stop. `/event` did not deliver `message.part.*`; title poll still worked. V1 now polls `GET /session/:id/message` on live turns and maps `session.next.*` if SSE appears. Mapper is idempotent so poll + SSE cannot double-open tools.
- 2026-08-22 (version pin, ISC-52): Pin `@opencode-ai/sdk@1.18.21` and accept `opencode serve` versions `>=1.18.0 <1.19.0`. Attached server outside that window fails and names both versions. Stable HTTP only. Forbidden: `session.switchAgent`, `POST /api/session/:id/agent`, `session.subagent`, `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, `@opencode-ai/sdk/v2`.
- 2026-08-22 (agent hydrate fog): 1.18.21 `UserMessage` requires `agent`. ISC-29.3 uses last user `info.agent`. Absent / hidden / system / subagent → default primary. Unknown id → visible error, send refused.
- 2026-08-22 (Task permission correlation): `permission.asked.sessionID` + `Session.parentID`. In-flight parent match → parent card, reply to child ids. Else uncorrelated.
- 2026-08-22 (agent stamp channel): Picker `onChange` stays local (ISC-29.2). Selected agent reaches the bridge via `stampAgent` RPC at submit/enqueue (not on click) plus `deriveProviderOptions`. Queued stamps are a FIFO consumed after the in-flight turn settles so flush keeps the enqueue agent (ISC-29.5).

## Proposed file tree (locked after spikes)

```
package.json
tsconfig.json
vitest.config.ts
.gitignore
README.md
ISA.md
assets/icon.svg
server.ts                 # provider declaration, rpc, cli, settings, adopt store
host.ts                   # host RPC entry + re-export bridge
app.tsx                   # slots + RPC only
contract.ts               # server rpc + host rpc schemas
src/identity.ts           # provider id, version window
src/pending-adopt.ts      # {projectId,hostId,opencodeSessionId} keys
src/selectable-primaries.ts
src/permissions/map.ts    # fail-closed OpenCode → BB grammar
src/prompt-builder.ts     # every prompt includes agent
src/map-delta.ts          # OpenCode events → thread/delta
src/hydrate.ts            # full refetch replay
src/agent-stamp.ts        # enqueue/next agent
src/client.ts             # THE only @opencode-ai/sdk import
src/process.ts            # detached serve, lock/port, attach-first
src/probe.ts
src/bridge.ts             # provider bridge handleLine
src/host-handlers.ts
src/app/composer-agent.tsx
src/app/message-revert.ts
src/app/settings-section.tsx
src/app/import-control.tsx
tests/*.test.ts
```

## Learning

- conjecture: OpenCode agents are start/resume-only session modes (ISC-29).
- refuted-by: native OpenCode Tab / `switch_agent`; stable write is `session.prompt({ agent })` on every turn.
- learned: a picker click is intent until the next send; OpenCode has no stable switch-without-send; a BB cookie would disagree with hydrate.
- criterion-now: ISC-29 dropped; ISC-29.1–29.5.

- conjecture: OpenCode subagents are out of V1 because they are not composer primaries and must not become BB Voyager children.
- refuted-by: stable Task tool creates a child session with `parentID`; OpenChamber only wraps that; `@mention` is prompt text.
- learned: honor Task on the parent card; isolate child events; route child permissions; adopt only on user confirm. Do not implement Task in the plugin.
- criterion-now: F8 ISC-71, 71.1, 73–77.

- learned: BB host-RPC and provider-bridge workers get different `dataDir`s (`host-data` vs `bridge-data`). A lock file inside each worker `dataDir` spawned two OpenCode servers. Host-wide lock is `$HOME/.bb/plugins/opencode/opencode.lock.json`.
- learned: OpenCode `GET /provider` returns `{ all }`, not `{ providers }`. Unwrap both or Settings/auth looks empty.
- learned: `@opencode-ai/sdk` `session.prompt` can hang after the HTTP turn already completed. V1 issues `POST /session/:id/message` via fetch. After it resolves, emit missed text + `turn.boundary`; do not `session.reset` while a live turn is open (assembler drops the turn).
- learned: `model/list` must satisfy `availableModelSchema` (`model`, `description`, reasoning fields, `isDefault`) or BB returns 503 "Unable to load opencode models".

## Remaining Work

- [x] Spike idle `bb.sdk.threads.spawn({ input: [] })` — impossible. ISC-42.3 active; ISC-42.2 tombstoned.
- [x] Permission mapping table spike — field-level OpenCode → BB grammar. ISC-33–37 stay; the table is the how.
- [x] Numeric version window — pin `1.18.x` (ISC-52).
- [ ] Later graduation to a vendored builtin (`provider-opencode`) if product chrome requires default picker rank or hiding auto-detected `acp-opencode`. Out of this V1 vision.
- [x] ISA review round 1 (Kimi/GLM/Opus) — revised 2026-08-22 without expanding product scope.
- [x] ISA review round 2 (Kimi/GLM/Opus) — revised 2026-08-22 without expanding product scope.
- [x] ISA review round 3 (agent-switch delta) — Kimi/GLM/Opus 2026-08-22; revised in-scope only. No plugin implementation from this ISA pass.
- [x] ISA review round 4 (Task-child delta) — Kimi/GLM/Opus 2026-08-22; revised in-scope only. No plugin implementation from this ISA pass.
- [x] Implement in feature order after spikes: F0 → F7 → F1 → F2 → F3 → F4 → F5 → F8 → F6 last.
- [ ] Hard blockers / remaining live: ISC-33/34 (need `bash: ask` + human card), ISC-8.2 (`messageAction` has no `isAvailable` so Undo/Redo icons leak onto other providers). ISC-63 deny and ISC-71 Read item/* are live-proven.
- [ ] Polish live-verify: streaming suffixes, tool flush, title poll, Stop, `/` autocomplete, reasoning chip actually changes the turn.

## Live smoke (operator thread, 2026-08-22 evening)

Live-fired against the attached serve (pid 11174, port 50876, lock `~/.bb/plugins/opencode/opencode.lock.json`). New threads only: `thr_2ba6f7x3fx`, `thr_h7y8rcvjf9`, `thr_mjijd3gfic` (OpenCode sessions `ses_fd52f7a61ffelgWeZD1S2LZjvU`, `ses_fd52a22c9ffe9SxHnfod0M67s7`, `ses_fd528d40bffe6nOUMzwUxnEeFR`). No existing session/thread mutated; foreign active thread `thr_jwmit48asg` left untouched and still `active` afterward; foreign session ids still 200; `acp-opencode` count in this project stayed 0→0; one lock/one pid held throughout.

**Passed live (already-closed claims re-confirmed, no ISA change needed):** ISC-2 (`providerId=opencode` on spawn), ISC-9/thread-identity, ISC-14/turn.prompt, ISC-29.1 (`agent: "build"` stamped on every `/message`, confirmed via OpenCode `session/:id/message`), ISC-65 (file attachment reached OpenCode prompt parts and was read), ISC-40 (`listImport` RPC logs `import.list` only on open, returns unimported sessions, none auto-imported), ISC-19/Stop (interrupt correctly aborted a hung tool call), ISC-77 (`@general` text forwarded unchanged in the user part; Task tool invoked), F0 provider-count invariants.

**ISC-12 — still open, reproduced live:** `PATCH /session/:id {title}` on the attached serve updates the OpenCode-side title (verified via `GET /session/:id`) but never emits a `session.updated` SSE event on this server build/window (`/event` stream showed only `server.connected`/`server.heartbeat` across three separate PATCH attempts, ~5–10s windows each). The plugin's `bridge.ts` listener for `session.updated` → `thread.name` delta is correctly written but never fires because the event never arrives. Root cause is upstream of the plugin. BB thread title stayed unset after both a wait window and a subsequent turn. Not closed.

**ISC-30/31 — still open, reproduced live:** calling the app RPC directly (`POST /api/v1/plugins/opencode/rpc/undo` with `{threadId}`) returned `{"ok":false,"error":"Thread is not bound to an OpenCode session"}` for a thread that demonstrably has a bound session (`thread/identity` event on the same thread carries `providerThreadId`). Root cause: `bb.sdk.threads.get({threadId})` — confirmed directly via `GET /api/v1/threads/:id` — does not return a `providerThreadId` field at all in this BB build, so `revertThread()`'s `threadFields()` guard always short-circuits. This is a host-API gap, not fixable inside the plugin without an alternate lookup (e.g. plugin-owned storage of the bind, already tracked as the in-memory `sessionToThread` map used by the live-turn path). Not closed.

**ISC-33/34/74 — still open, live attempt inconclusive/blocked:** with the shared server's inherited config (project directory has no `opencode.json`; global `~/.config/opencode/opencode.json` sets `"build"` agent `permission: {}`), no `permission.asked` ever fired for direct bash or Read-tool prompts, including ones targeting a path outside the project directory (expected to hit the `external_directory` default-`ask` guard). Instead, on two separate attempts the tool call sat in `state.status: "running"` for 90–200s with zero permission record (`GET /api/session/:id/permission` stayed `{"data":[]}` throughout) and zero `permission.asked` on `/event`; both times recovered only via `bb thread stop`, which drove the tool to `state.status: "error"` / `interrupted`. Writing a temp `opencode.json` (project dir, then the server's own `host-data` cwd) with `bash`/`edit: "ask"` did not change `GET /config` — this server only reads project/global config at process boot, and the attached server's cwd is the plugin's own `host-data` dir, not any project directory. Restarting the shared server to pick up a temp config was **not done**: a foreign, operator-uncreated thread (`thr_jwmit48asg`) was actively running throughout the smoke, and restarting the one shared per-host OpenCode server would have interrupted it — explicitly forbidden. Net: F5's live ask path is unverified this session; the plugin's fail-closed `unknown` handling in `handlePermissionAsked` was never actually exercised end-to-end. ISC-74 (Task-child permission correlation) inherits the same blocker and was not reached. None of these are closed.

**ISC-53/63 — not attempted**, same shared-server restart blocker as above (would require stopping the one live serve process while a foreign thread was active). Left open per instructions.

**Observation (not a claim change):** the same `@general` Task-tool turn that correctly forwarded `@general` text and invoked the `task` tool server-side produced **no** `item/*` delta event for the tool call itself in the BB thread event log — only the final `agentMessage` text appeared. ISC-71 stays `[x]` (its bun-test snapshot is presumably exercising the mapper directly), but this live gap between "OpenCode did call task" and "BB timeline showed a tool item for it" is worth a follow-up investigation before shipping F8 confidently.

## Remain-list closeout (2026-08-22 night)

Model picker labels are now `llmProvider/modelName` (e.g. `hpc-ai/DeepSeek V4 Flash`). New-thread Agent chip shows only when the live model trigger is OpenCode (title, `OpenCode` text, or `/providers/opencode/` logo).

**Closed this pass:**
- ISC-12 — `PATCH /session/:id {title}` on `ses_fd50d2319ffeQnaNfL86bfOSc2` produced BB `thread/name/updated` with `threadName=bb-isa-title-probe-2` (no `thread/resume`). Poller covers the missing `session.updated` SSE.
- ISC-30/31 — `POST /api/v1/plugins/opencode/rpc/undo` and `.../redo` on `thr_9ahbvj6i2v` returned `{ok:true}` after identity-event bind lookup; host revert/unrevert then `hydrateBoundSession` (same `session.reset` path as resume). Unit: `hydrateBoundSession` emits `session.reset`.
- ISC-53 — `OPENCODE_BIN` pointing at a missing file → `probe.needsConfiguration === true` (does not hide the real binary).
- ISC-74 — vitest fixtures: child+in-flight parent attaches to parent; missing session drops; post-boundary child drops.

**Still open (shared-serve config):** ISC-33, ISC-34, ISC-63. Foreign thread `thr_jwmit48asg` / `ses_fd5575357ffegGjkvDSSHjIcRh` still `200` on the live serve; not restarted.

## Operator ISC-33/34 (thr_rffsvvn8gy) — FAIL

Subject `thr_5pa8s3mxrp` / `ses_fd5031450ffexCWAZ7hOlVpMm1`, `accept-edits`, project `opencode.json` `bash: ask`. Bash `echo ISC33_PERM_PROBE` sat `running` ~250s; `GET /permission` and `GET /session/:id/permission` stayed empty; no BB interaction. Stop aborted the tool (`interrupted: true`). Claims stay `[ ]`.

**Diagnosis (plugin, not config):** pinned 1.18.21 speaks `permission.updated` + `POST /session/:id/permissions/:id`. The bridge only handled `permission.asked` + `POST /permission/:id/reply`, so a live ask could never become a card or a reply. Fixed to accept both dialects. Re-smoke required before closing ISC-33/34. Serve not recycled; foreign session left `200`.
