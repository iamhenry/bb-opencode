# OpenCode footer updater verification

## Candidate provenance

- Publication base: `27b14280125e46c4bf45ee5d953a6bef4894c456` (`origin/main` at publication preflight).
- All published production and test files are byte-for-byte identical to the completed candidate.
- Production/test blob-manifest SHA-256: `0b750f6a2eb949def78ed722f5f9161235765fecbea1e89ebe2499a9e0c3bf36`.
- Final focused command passed **77/77 tests across 6 files**: identity, process, installer artifact, launch ownership, footer UI, and update lifecycle.
- `npx tsc --noEmit` and `git diff --check` passed on the final candidate.
- An earlier full Vitest run passed **405 tests** before the final test-only deduplication; the final focused 77-test run covered the affected OC-13 paths after cleanup.

## Controlled browser proof

The disposable browser harness imported the real candidate `src/app/update-control.ts` and CSS, then supplied controlled in-memory RPC responses and representative footer anchors. It did not copy the control markup and did not run a real installer. Each image visibly states that it is a controlled harness with no real update performed.

- [`screenshots/available.png`](screenshots/available.png) — `Update` at a 260px sidebar width.
- [`screenshots/narrow-available.png`](screenshots/narrow-available.png) — `Update` at a 190px sidebar width.
- [`screenshots/failed.png`](screenshots/failed.png) — retryable failure with wrapped detail.
- [`screenshots/restart-pending.png`](screenshots/restart-pending.png) — installed, activation pending.
- [`screenshots/current-absent.png`](screenshots/current-absent.png) — no update control when current.

The measured normal and narrow layouts had no horizontal menu overflow. Existing Settings and Report-a-bug controls remained visible and clickable. In the controlled pending state, clicking the same footer action invoked activation rather than reinstalling or navigating to Settings.

## Production wiring and limits

The production source routes the footer action through BB provider maintenance, exact post-install version checks, and guarded BB-owned activation. It refuses downgrades, unsupported versions, foreign ownership, conflicting maintenance, and busy activation; busy work leaves a restart-pending action instead of interrupting sessions.

**NOT VERIFIED:** actual installed-BB integration, a real global OpenCode upgrade, and live BB activation. The screenshots are controlled real-candidate harness evidence, not an installed BB session and not evidence of a real download or upgrade. No live CLI, server, plugin, configuration, session, credential, or OpenChamber mutation occurred during this verification.
