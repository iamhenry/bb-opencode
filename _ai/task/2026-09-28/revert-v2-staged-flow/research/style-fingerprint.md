# Style cheatsheet

- TypeScript ESM imports use explicit `.js` suffixes; app components use `.tsx` (`app.tsx`, `src/client.ts`).
- Two-space indentation, double quotes in `.ts` files, semicolons, and trailing commas are the local convention (`src/client.ts:1-10, 417-423`).
- Keep external SDK/API calls behind `OpenCodeClient`; plugin host handlers acquire/reuse clients and return small `{ ok, error }` result objects (`src/client.ts:35-113`; `src/host-handlers.ts:247-291`).
- Validate host and app RPC payloads with strict Zod objects in the central `contract.ts` (`contract.ts:128-145, 362-386`).
- Make UI state explicit with React hooks and the typed BB composer/realtime/RPC hooks (`src/app/revert-dock.tsx:51-74`). Preserve composer restoration per thread via `sessionStorage` and guard optional storage operations (`src/app/revert-dock.tsx:21-49`).
- Prefer focused pure helpers for projection/mapping and test their observable contracts in Vitest (`src/revert-projection.ts`; `tests/revert-projection.test.ts`, `tests/revert-target.test.ts`).
- Keep plugin UI integration thin: register the app slot in `app.tsx`, delegate behavior to `src/app/*`, use host RPC for server/session operations, and avoid direct browser calls to OpenCode.
- Existing OpenCode v2 adapter methods use generated SDK resource calls and narrow `as never` casts where the client's current typing is insufficient (`src/client.ts:417-423`). Add the new method alongside these rather than bypassing the adapter.
- No extra dependency is indicated; use BB's existing icon registry and OpenCode SDK methods.
