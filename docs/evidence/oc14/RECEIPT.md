# OC-14 real-surface smoke receipt (sanitized)

Cheap live smoke, 2026-09-06, against loaded plugin baseline (main @ 27b1428, pre-fix).
One parent/child BB `thread spawn` delegation; child replied "OK" only; no tools.

- Parent: pinned explicitly to `xai/grok-4.6` (cheap, distinct). Run chip: `xai/grok-4.6 · high · build`.
- Child: spawned with NO model/provider/agent flags. Run chip: `openai/gpt-5.6-sol · high · build`.
- Recorded inference metadata (OpenCode session export): child first user message and assistant
  message model = providerID `openai`, modelID `gpt-5.6-sol`; matches the run chip.
- Expected effective agent config (`build` frontmatter): `ollama-cloud/glm-5.3-flash` — NOT what ran.
- Attribution: BB filled the model from its remembered project default and recorded it explicitly as
  `execution.model` on the child's turn request (`client/turn/requested`). The child did NOT inherit
  the parent's model, and the plugin bridge's remembered-model fallback was never reached on this
  dispatch surface (BB always sends an explicit model).

These screenshots prove the observed baseline behavior and BB project-default attribution only.
They do NOT show that the speculative fallback patch in this PR fixes the reported symptom.
