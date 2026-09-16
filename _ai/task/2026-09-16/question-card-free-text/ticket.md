# Question cards never show free-text "Other…" field

Type: Bug

## What happened

BB question cards rendered by the opencode plugin never showed the free-text
"Other…" option, even though OpenCode's `question` tool defaults `custom` to
`true` when omitted (schema annotation: "Allow typing a custom answer
(default: true)"). The plugin flattened an absent `custom` to `false`
(`record.custom === true`), so `allowFreeText` was false whenever the model
didn't explicitly pass `custom: true` — the common path, since OpenCode's tool
`Prompt` parameter type doesn't even expose `custom`.

Secondary: `USER_QUESTION_MAX_OPTIONS = 4` silently truncated option lists; a
5th "Other…" option the model added was dropped before BB rendered the card.

## What should happen

- Absent `custom` maps to free text allowed (matching OpenCode's default).
- When options are truncated at the 4-option cap, free text auto-enables so a
  dropped option can't strand the user.

## Repro

1. Ask any question via the tool without passing `custom` (the default path).
2. BB card shows only the radio options — no write-in field.

## Evidence

- OpenCode schema: `custom` optional, default true
  (packages/schema/src/v1/question.ts, upstream).
- Plugin mapping: `src/questions.ts` `parseQuestion` / `toUserQuestionPayload`.
- BB renderer honors `allowFreeText` (shows "Other…" when true); the payload
  just never set it.

## Fix

- `parseQuestion`: `custom: record.custom !== false` (explicit false still wins).
- `toUserQuestionPayload`: `allowFreeText = question.custom || truncated || options.length === 0`.

## Verification

- Full suite: 56 files / 411 tests passed.
- Live test after plugin reload: free-text answer round-tripped end to end
  (user typed a custom answer; it reached the session).

## Follow-up

Upstream feature request for image attachments on answers:
- OpenCode (provider contract half): https://github.com/anomalyco/opencode/issues/49405
- get-bb/bb (card/payload half): https://github.com/get-bb/bb/issues/3795
- Each issue cross-links the other; both must land compatibly for the feature to work end to end.