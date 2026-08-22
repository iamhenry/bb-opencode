# bb-plugin-opencode

First-class OpenCode provider for [BB](https://github.com/get-bb/bb). Provider id: `opencode`.

One detached `opencode serve` per host. BB threads bind 1:1 to OpenCode sessions. Import is manual. Task children stay on the parent card until you adopt them.

## Requirements

- BB `>=0.39` / plugin SDK `>=0.4.14`
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
```

Override the binary with `OPENCODE_BIN`.

## Phone (PWA + iOS app)

OpenCode threads run on any BB client. The native iOS app does not execute plugin frontends, so the Agent chip, slash banner, and bubble Revert/Redo are web-only. On the phone: pick **OpenCode** in the provider list, send as usual, long-press **Fork** or **Edit** (native rewind), and answer Allow/Deny on the native card. Set **Default OpenCode agent** under Tools → OpenCode if you are not on `build`. The mobile PWA is the web app: compact composers hide the footer chip, so the same picker appears as a banner above the prompt.

## Layout

`server.ts` declares the provider. `host.ts` owns the SDK, detached process, and `thread/delta` bridge. `app.tsx` is slots + RPC only.
