# Release checklist

## Notarization

The local developer build is intentionally not notarized. A locally built app does not carry the `com.apple.quarantine` extended attribute, so Gatekeeper does not assess it.

If the app is ever distributed as a Homebrew cask, the release process must:

- [ ] Set `ENABLE_HARDENED_RUNTIME = YES` for the distributed build.
- [ ] Store notarization credentials once with `xcrun notarytool store-credentials <profile>`.
- [ ] Submit the signed release artifact from the release script with `xcrun notarytool submit <artifact> --keychain-profile <profile> --wait`.
- [ ] Staple the accepted notarization ticket from the release script with `xcrun stapler staple <app-or-container>`.

A cask download carries the `com.apple.quarantine` extended attribute, which triggers Gatekeeper assessment. That is why notarization becomes mandatory for cask distribution and is not needed for the current local build.
