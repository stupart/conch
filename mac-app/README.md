# conch macOS viewer

A minimal, read-only SwiftUI viewer for the live conch daemon state. The app polls `/tmp/conch-sessions.json`; start the conch daemon before running the viewer.

Requirements: macOS 14 or later and Xcode 16 or later.

Open `conch-mac.xcodeproj` in Xcode, select the `conch-mac` scheme, and press Run. To build from the repository root:

```sh
xcodebuild -project mac-app/conch-mac.xcodeproj -scheme conch-mac build
```

The viewer contains no microphone, voice, or TTS functionality and does not write to the daemon state file.
