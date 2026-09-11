# AGENTS.md

When adding a feature to this plugin, study how these already do it, then adapt. Do not copy chrome this plugin left out.

- [OpenCode SDK](https://opencode.ai/docs/sdk/) — sessions, events, permissions; the API this plugin talks to
- [OpenChamber](https://github.com/openchamber/openchamber) — OpenCode workspace (goals, multi-run, fusion, walkthrough, preview)
- [T3 Code](https://github.com/pingdotgg/t3code) — agent control surface; OpenCode as one of several providers
- [Paseo](https://github.com/getpaseo/paseo) — multi-agent orchestration; OpenCode as one provider

## Completion proof

- Run proportional tests, type checks, and builds for code health. They do not prove a behavior change is complete.
- Verify changed behavior on the exact candidate through the real BB or user entry point. Choose the proof path by the behavior, not by whether the changed files are UI or backend code.
- Use the smallest evidence that can disprove the claim: a screenshot for a static result, or a short recording when motion, loading, animation, transition continuity, gesture response, or timing is the claim.
- If the real path cannot run safely, report `BLOCKED` or `user outcome unverified`. Never report `PASS`, done, or end-to-end success from mechanical checks alone.
