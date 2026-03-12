# BrainrotMaxxing

BrainrotMaxxing runs Instagram Reels inside VS Code using a local sidecar process that launches your installed Chrome-family browser and streams it into a webview.

## Commands

- `BrainrotMaxxing: Open Reels in VS Code (Sidecar)`
- `BrainrotMaxxing: Validate System Browser Runtime`
- `BrainrotMaxxing: Run Sidecar Diagnostics`
- `BrainrotMaxxing: Restart Sidecar`

Compatibility command kept:

- `brainrotmaxxing.openInstagramSideBySide` (routes to sidecar open flow)

## Runtime Requirement

A supported system browser must be installed:

1. Google Chrome (preferred)
2. Microsoft Edge
3. Brave

The extension validates these in that order and uses the first detected executable.

## How It Works

1. Run `Validate System Browser Runtime` once.
2. Run `Open Reels in VS Code (Sidecar)`.
3. Login and browse normally inside the sidecar panel.
4. If persistent profile lock is detected, the extension resets sidecar state, retries persistent profile once, then falls back to a temporary recovery profile for that session.

## Settings

- `brainrotmaxxing.profile.mode` (`persistent` default)
- `brainrotmaxxing.viewport.mode` (`desktop` default)
- `brainrotmaxxing.stream.fpsCap` (`30` default)
- `brainrotmaxxing.audio.enabled` (`true` default, Phase 2 placeholder)

## Diagnostics

`Run Sidecar Diagnostics` writes a report in the `BrainrotMaxxing Diagnostics` output channel including:

- runtime executable + browser/version/source
- sidecar transport metrics (latency, dropped frames, connected clients)
- codec probe status (H.264/AAC support heuristics)
- profile lock recovery counters
- profile health
- audio phase status
- risk level and recommendations

## Current Phase

This release is still Phase 1:

- in-editor sidecar streaming and controls
- system runtime validation for better video compatibility
- persistent profile support and lock recovery

Audio sync pipeline is planned for Phase 2.

## Development

```bash
npm install
npm run compile
npm test
```
