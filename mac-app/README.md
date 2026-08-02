# conch for macOS

The native macOS app is conch's primary window. It shows the daemon's live session ledger and conversation, follows speech and dictation as they happen, and renders finished deliverables inline for review. Deliverables can also be expanded to fill the window.

The app polls `/tmp/conch-sessions.json` for state and sends talk/stop, recite, pause/resume, and mute/unmute controls to the running daemon over `/tmp/conch.sock`. The daemon still owns microphone capture, transcription, and speech synthesis, so start conch before opening the app.

Requirements: macOS 14 or later and Xcode 16 or later.

## Install

From the repository root, build the Release configuration and install it at `/Applications/conch.app`:

```sh
./scripts/build-app.sh
```

The app is signed with a Developer ID identity so macOS permission grants, including notifications, persist across rebuilds. It is intentionally not notarized because a locally built app does not carry the quarantine attribute and does not need notarization.

Open `conch-mac.xcodeproj` in Xcode, select the `conch-mac` scheme, and press Run. To build from the repository root:

```sh
xcodebuild -project mac-app/conch-mac.xcodeproj -scheme conch-mac build
```
