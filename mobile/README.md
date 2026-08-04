# conch for iPhone

The Mac does the work; the phone is a glance and a voice.

- **Pair once**: run `conch pair` on the Mac, type the host and code into the
  phone. The token lives in the Keychain — it can read session transcripts, so
  it gets credential storage.
- **The ledger** mirrors the Mac dashboard's status vocabulary exactly — same
  glyphs, same colours, same meanings.
- **Talk**: open a session, tap Talk, speak, tap Send. Transcription happens
  on the phone (SFSpeechRecognizer, on-device where supported); only text
  crosses the network, delivered through the daemon's own injection machinery.
- **Reviews**: a starred session's deliverable opens in-app — web, image, PDF,
  markdown, and text all render fully; local files are served by the bridge's
  scoped `/file` endpoint, which only ever serves what the dashboard is
  currently showing.

Build: `xcodebuild -project mobile/conch-ios/conch-ios.xcodeproj -scheme conch-ios`.
The simulator can pair headlessly via `CONCH_PAIR_HOST` / `CONCH_PAIR_TOKEN`
launch environment (the screenshot harness uses this; never persisted).
