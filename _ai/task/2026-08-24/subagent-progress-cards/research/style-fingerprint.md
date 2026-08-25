# Style cheatsheet

- TypeScript ESM; explicit `.js` local import suffixes.
- Small pure helpers near their only caller; avoid one-use classes/abstractions.
- Early returns for unsupported/missing payloads.
- Best-effort OpenCode synchronization catches failures without breaking parent chat.
- Provider behavior is tested with Vitest fake OpenCode events in `tests/bridge.test.ts`.
- Native BB bridge shapes are preferred over custom frontend chrome (`ISA.md:50,141,282-290`).
- Keep diffs focused; recent history uses small `fix:` commits.
