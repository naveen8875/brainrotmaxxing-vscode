# Changelog

All notable changes to this project are documented in this file.

## [0.0.9] - 2026-03-12

### Changed

- Runtime flow now requires and validates a locally installed system browser runtime instead of downloading open-source Chromium.
- Added browser detection priority for runtime selection: Google Chrome -> Microsoft Edge -> Brave.
- Runtime metadata now records runtime source plus browser name/version for diagnostics.
- `Install Runtime` command is repurposed to runtime validation and surfaced as `Validate System Browser Runtime`.
- Removed runtime channel setting from extension configuration.

### Fixed

- Improved persistent profile lock recovery flow:
  - reset sidecar session
  - retry persistent profile once
  - fallback to temporary recovery profile only if lock persists
- Sidecar panel now uses full-bleed viewport layout with auto-hide toolbar so Instagram can use maximum panel space.
- Added startup codec probe telemetry (H.264/AAC/WebM support heuristics) and targeted warnings when support looks insufficient.
- Diagnostics now include runtime browser identity, codec probe details, and accumulated profile lock events in risk scoring.

## [0.0.8] - 2026-03-12

### Fixed

- Sidecar panel now sends live resize events to the Chromium worker so Instagram reflows responsively with panel size.
- Reduced heartbeat overlay noise further by increasing stale thresholds (ping/inbound inactivity windows).
- Sidecar now better fills available panel space while staying interactive.

## [0.0.7] - 2026-03-12

### Fixed

- Reduced false-positive sidecar overlays by switching stale detection from frame cadence to websocket heartbeat (`ping/pong`) health.
- Overlay now appears primarily on real stream disconnect/heartbeat loss instead of static-page frame pauses.

## [0.0.6] - 2026-03-12

### Fixed

- Added automatic recovery when persistent profile lock (`ProcessSingleton`) is detected:
  - retries sidecar open with a temporary recovery profile for the current session.
- Improved sidecar error messages by trimming long worker call logs to actionable summaries.
- Reduced zoomed-in appearance by preventing forced image upscaling in the viewer.
- Changed default viewport mode to `desktop`.

## [0.0.5] - 2026-03-12

### Fixed

- Fixed sidecar worker path resolution in packaged extensions.
- Sidecar now resolves worker script from `out/sidecar/worker.js` correctly when installed from VSIX.

## [0.0.4] - 2026-03-12

### Added

- Chromium sidecar architecture for in-editor Reels playback via webview streaming.
- Runtime installer command:
  - `brainrotmaxxing.installRuntime`
- New sidecar open command:
  - `brainrotmaxxing.openReelsSidecar`
- Sidecar restart command:
  - `brainrotmaxxing.restartSidecar`
- Expanded diagnostics command output for sidecar runtime/transport/profile/audio status.
- New sidecar worker process (`out/sidecar/worker.js`) with websocket frame/input transport.
- New extension settings:
  - `brainrotmaxxing.runtime.channel`
  - `brainrotmaxxing.profile.mode`
  - `brainrotmaxxing.viewport.mode`
  - `brainrotmaxxing.stream.fpsCap`
  - `brainrotmaxxing.audio.enabled`

### Changed

- Compatibility command `brainrotmaxxing.openInstagramSideBySide` now routes to sidecar open flow.
- Main command title updated to `Open Reels in VS Code (Sidecar)`.
- Diagnostics now persist sidecar-oriented risk snapshots.
- Version bumped to `0.0.4`.
