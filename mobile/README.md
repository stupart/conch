# conch for iPhone

The Mac does the work; the phone is a glance and a voice.

Use the phone bridge only on a trusted LAN. It uses plaintext HTTP and
WebSocket traffic with no transport encryption. The bearer token appears in
query strings for WebSocket and file requests, so anyone who can observe that
traffic can reuse it. Do not enable the bridge on an untrusted or shared
network.

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

## Verifying visuals

Build and screenshot on an **iOS 26** simulator. iOS 17/18 render toolbar
buttons flat, so glass-button work judged there looks broken when it isn't —
that cost a round of "you removed the glass" when nothing had changed. Shut
sims down when finished; several may be in use by other work on this machine.
