# iOS composer: model chip collapses to logo (issue #37)

Source: https://github.com/iamhenry/bb-opencode/issues/37

## Problem
BB iOS app, new-thread composer with OpenCode: model chip shows only its logo,
overlapping the `build` chip's bot icon. Label + chevron missing. Web is fine.

## Lessons from thr_4af5cb8u34 (do not repeat)
- Desktop Chromium at 390px never reproduced it. Reproduce in real WebKit + touch
  (iOS Simulator Safari against the live BB server) before patching.
- A CSS min-width guess was shipped without a repro and did nothing on the phone.
- Fix must live in this plugin (user decision), not BB core.

## Done
- iOS: model chip shows logo, label (truncated ok), chevron next to `build` + mic,
  no collapse after 10s. Web unchanged. Owner confirms on phone.

## Cause (proven from the real iPhone, iOS 18.6.2, 375px)
Device probe: the model chip's OpenCode logo SVG rendered at w=300 (the SVG default)
inside BB's `min-w-max size-4` icon slot. Label width 0, chevron at x=381 (off-screen).
Chromium resolves the same slot to 16px, so desktop could never reproduce it.

## Fix
`src/app/provider-icon.tsx`: add width="16" height="16" to the OpenCode SVG.
Chromium after: 375 touch svg=16 label=81px; 1200 svg=16 label=162px (unchanged).
Pending: owner confirms on phone. Then remove TEMP(#37) probe (composer-agent.tsx,
server.ts, contract.ts) and restore the cached install, or ship via GitHub.
