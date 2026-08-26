# bb-opencode

First-class OpenCode provider for [BB](https://github.com/get-bb/bb).

This is **not** BB’s built-in ACP guest (`acp-opencode` / plugin `provider-acp`). That path runs `opencode acp`. This plugin talks to a detached `opencode serve` as provider id `opencode`, shown in the picker as **OpenCode**. Existing ACP threads stay ACP; they are not migrated.

One detached `opencode serve` per host. BB threads bind 1:1 to OpenCode sessions. Work is scoped to the project directory. Import is a button you press. Deleting a BB thread does not delete the OpenCode session.

## What you can do

Pick **OpenCode** and use it like Claude-in-BB.

**Chat**
- New thread creates an OpenCode session. Resume is that same session (history is not replayed). If it is still running, BB joins it.
- Stop interrupts the parent and any live Task children.
- Rename in BB writes the title to OpenCode. OpenCode’s own title replaces “New session”; a title you set in BB is kept.
- Follow-ups while a turn is running queue, unless BB’s “steer active thread on Enter” is on, then they inject.
- BB project instructions go with the prompt.

**Model and agent**
- Model picker lists providers you already authenticated in OpenCode. If you don’t pick one, OpenCode’s configured default is used. Reasoning effort is whatever that model actually offers.
- Thread context meter (tokens vs window). Last assistant bubble shows model, reasoning, and agent.
- Agent chip: `build` / `plan` / `orchestrator` and other listed primaries. Change applies on the **next send**, not mid-stream. Default under Tools → OpenCode (needed on iOS). Hidden on ACP OpenCode threads.
- `@name` in the prompt mentions an agent or subagent. It is sent as text; the plugin does not rewrite it into a Task.

**Commands and skills**
- BB’s `/` picker reads `~/.config/opencode/{commands,skills}` and `.opencode/{commands,skills}`.
- `/compact` or `/summarize` compacts. OpenCode auto-compact is not run twice.
- BB project skills are listed in the prompt. This plugin does not write `opencode.json`.

**Permissions and questions**
- Modes: Accept edits / Approve for me / Full access. The footer choice applies on the next OpenCode ask. BB is a ceiling; OpenCode’s once/always and `opencode.json` still apply. Unknown asks are never auto-approved.
- Allow / Deny / Always on BB’s card for bash, file edits, and other tools. Allow and bash output stay on one row.
- Agent questions show as BB pickers.

**History**
- Native **Fork** (checkpoint) and **Edit** (resend from that turn).
- On web: **Revert from here** on a bubble rewinds the OpenCode thread in place; **Redo** in the composer dock. Hidden messages after revert.

**Files**
- Attach local files and images. One unsupported type fails the whole send. A slash plus an attachment is a normal prompt, not a command.

**Timeline**
- Streaming text and thinking. Live bash. File reads, edits/diffs, search/glob, web search/fetch. Todos as plan steps. Retries and errors show as themselves.
- Task / `@subagent` work is a nested card on the **parent**. Child thinking and prose stay off the parent. Open a Task child as its own thread when you choose; it is not auto-created.

**Import**
- Tools → OpenCode → Import. Lists sessions only after you open it. Running, already-imported, or missing-directory sessions are blocked. Idle Task children are pre-checked when present; otherwise parents are. Importing a parent does not pull in its children.

**Auth and health**
- `opencode auth` on this machine, then send again.
- Tools → OpenCode: binary, version, attach state, port. CLI below. Override the binary with `OPENCODE_BIN`.

## What is left out

Still true from V1, plus a few later cuts.

- Not the ACP guest. No migration of `acp-opencode` threads.
- No install/update/login of OpenCode from BB. No `bb opencode restart`. No account quota, plan, or email.
- No service tiers. No thread archive.
- No auto-import. No header “Open Task”. No custom Task card.
- Agent picker does not list subagents. Changing the chip does not interrupt the current turn.
- Native **iOS app** does not run plugin UI: no Agent chip, slash banner, or bubble Revert/Redo. Pick OpenCode, send as usual, long-press **Fork** or **Edit**, answer Allow/Deny on the native card, set default agent in Tools → OpenCode. The mobile PWA is the web app (compact composers use a banner above the prompt).
- OpenCode TUI/desktop, MCP/LSP settings, session share, worktrees, background Task, and keybinds stay in OpenCode.
- OpenChamber chrome is not this plugin (goals, multi-run, fusion, walkthrough, preview, relay, second transcript).
- Pinned to OpenCode `1.18.x`. Out-of-window servers are rejected.

## Requirements

- BB `>=0.39` / plugin SDK `>=0.4.16`
- OpenCode `>=1.18.0 <1.19.0` (SDK pin `1.18.21`)

## Install

```sh
npm install
bb plugin install .
```

## Operator commands

```sh
bb opencode status
bb opencode version
bb opencode logs
bb opencode commands [directory]
```

## Layout

`server.ts` declares the provider. `host.ts` owns the SDK, detached process, and `thread/delta` bridge. `app.tsx` is slots + RPC only.
