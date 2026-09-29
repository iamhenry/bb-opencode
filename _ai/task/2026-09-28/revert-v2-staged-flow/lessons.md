# Lessons

- BB SDK `messageAction` has no per-role filter (checked through 0.5.31); hiding it on assistant rows needs a content script.
- The plugin message-action icon is drawn from the plugin's `bb.branding.icon` asset, not the icon name, whenever branding is declared. Check host precedence before trusting icon-name fixes.
- The branding asset URL carries a `?h=` cache query; match it by prefix.
- A BB thread running on this plugin is disturbed by reinstalling/reloading the plugin. Do live tests in disposable threads, and expect already-running provider bridge processes to keep old code — use a fresh thread after a reload.
- `bb plugin install <path>` refuses when the ID is installed from another source; `bb plugin remove opencode` first.
- OpenCode Task refuses agents with `mode: primary` (e.g. build); the running server caches agent config until restart.
- A single build agent given a large multi-part plan stalled in analysis; slice by file ownership with a fixed shared interface, and give it the concrete mapping route up front.
- Tests passed through three QA failures. Only the real BB UI exposed the event-limit, selector, icon, stopped-turn, subagent-notice and opening-prompt bugs; prove in the UI first, then add tests.
- For OpenCode API probes, reuse the plugin client via `npx vite-node` from the repo root (it resolves the server's auth headers); plain curl gets 401.
