# OpenCode update not offered in BB UI

## Problem
BB Settings → Updates shows OpenCode 2.0.18 as up to date while 2.1.1 exists; the footer pill omits OpenCode; a click would be refused while any OpenCode chat turn is open; Settings → OpenCode does not say a restart is pending.

## Contract
- Current: `src/update.ts` `providerInstallationStatus` hardcodes `installAction: null`, `needsUpdate: false`; `holdBlockMessage()` refuses install while any start guard (held for whole turns) exists; `src/app/settings-section.tsx` shows only one version beside "Reload OpenCode"; `src/app/update-control.ts` footer control never mounts on current BB.
- Ideal: Settings → Updates shows OpenCode current → latest with an Update button; BB footer pill includes OpenCode; click works while chats run (binary swap only); Settings → OpenCode shows "Installed X, running Y — Reload OpenCode to apply".
- Scope IN: provider status/run in `src/update.ts`, install path of the hold check (`src/hold.ts`), settings pending note, removal of dead custom footer control, README. OUT: running the real upgrade (user does it manually), auto-restart, bridge turn logic, BB core.
- Verification: local build loaded in live BB → `bb updates status --json` shows OpenCode `needsUpdate:true`, `installAction.kind:"update"`; screenshots of Settings → Updates, footer pill, Settings → OpenCode.
- E2E smoke: open BB with a chat running → footer pill names OpenCode, Settings → Updates shows OpenCode Update button, Settings → OpenCode shows pending note. Update click left to user.

## Decisions
- Install ignores start guards (upgrade renames a new binary into place; running service keeps old inode). Restart/reload still respects start guards + busy sessions.
- Footer via BB native update pill (user: "i dont care how its shown i just want a button in the footer").
