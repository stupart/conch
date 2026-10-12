import ConchDesign
import SwiftUI

/// Settings › Browser (2026-10-11): conch's browser profiles, and the one button that copies Chrome's sign-ins into them
/// (`ChromeImport`). Laid out as Environments is: the section's header, then its blocks under subheadings with the page's
/// hairline between them, in the one scroll view the page stops at its column.
struct ConchBrowserSettingsView: View {
    @ObservedObject private var store = ChromeImportStore.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                SettingsSectionHeader(title: "Browser", subtitle: "conch's own browser: its profiles, and your sign-ins from Chrome.")
                VStack(alignment: .leading, spacing: 24) {
                    BrowserProfilesBlock(store: store)
                    SettingsHairline()
                    ChromeImportBlock(store: store)
                }
            }
            .font(ConchTypography.font(size: 12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(SettingsLayout.inset)
        }
        .background(ConchPalette.bg)
        .task { await store.refresh() }
    }
}

/// conch's profiles, from the daemon, each with the cookies the last import put in it.
private struct BrowserProfilesBlock: View {
    @ObservedObject var store: ChromeImportStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSubheading(title: "Profiles") {
                Image(systemName: "person.2").font(.system(size: 13, weight: .regular))
            }
            switch store.profiles {
            case .loading:
                HStack(spacing: ConchSpace.x2) {
                    ProgressView().controlSize(.small)
                    Text("Loading profiles…").foregroundStyle(ConchPalette.textDim)
                }
            case .needsUpdate:
                Text(ChromeImportStore.needsUpdate).foregroundStyle(ConchPalette.statusNeeds)
            case .unreachable:
                Text("conch's daemon isn't running, so its profiles can't be listed. Turn it on in General.")
                    .foregroundStyle(ConchPalette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            case let .failed(error):
                Text(error).foregroundStyle(ConchPalette.statusNeeds).fixedSize(horizontal: false, vertical: true)
            case let .loaded(profiles):
                Text("Each has its own sign-ins. Default is the one conch's browser opens with.")
                    .foregroundStyle(ConchPalette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                OnboardingCard {
                    ForEach(Array(profiles.enumerated()), id: \.element.id) { index, profile in
                        if index > 0 { SettingsHairline() }
                        BrowserProfileRow(name: profile.name, cookies: store.importedCounts[profile.id])
                    }
                }
            }
        }
    }
}

private struct BrowserProfileRow: View {
    let name: String
    let cookies: Int?

    var body: some View {
        HStack(spacing: ConchSpace.x3) {
            Text(name)
                .font(ConchTypography.font(size: 12.5, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
                .lineLimit(1)
            Spacer(minLength: ConchSpace.x3)
            if let cookies {
                Text("\(cookies.formatted()) \(cookies == 1 ? "cookie" : "cookies") from Chrome")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "Import logins from Chrome": the button, what it does, where it's got to, and then each profile's counts.
private struct ChromeImportBlock: View {
    @ObservedObject var store: ChromeImportStore

    static let explanation = "Copies your Chrome sign-ins into conch's browser, one conch profile per Chrome profile. macOS will ask you to allow conch to read Chrome Safe Storage."

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsSubheading(title: "Import logins from Chrome") {
                Image(systemName: "square.and.arrow.down").font(.system(size: 13, weight: .regular))
            }
            Text(Self.explanation)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: ConchSpace.x3) {
                Button(store.reports.isEmpty ? "Import logins from Chrome" : "Import again") {
                    Task { await store.importFromChrome() }
                }
                .disabled(store.isImporting)
                if store.isImporting { ProgressView().controlSize(.small) }
            }
            if let line = status {
                Text(line.words)
                    .foregroundStyle(line.isProblem ? ConchPalette.statusNeeds : ConchPalette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                    .monospacedDigit()
            }
            if !store.reports.isEmpty {
                OnboardingCard {
                    ForEach(Array(store.reports.enumerated()), id: \.element.id) { index, report in
                        if index > 0 { SettingsHairline() }
                        ChromeImportReportRow(report: report)
                    }
                }
            }
        }
    }

    /// One line under the button: what's happening, what went wrong, or what there is to copy.
    private var status: (words: String, isProblem: Bool)? {
        switch store.importState {
        case .idle:
            if !store.chromeInstalled { return ("Chrome isn't installed on this Mac, so there's nothing to copy.", false) }
            guard let found = store.chromeProfiles else { return nil }
            if found.isEmpty { return ("Chrome has no profiles with sign-ins to copy.", false) }
            return ("In Chrome: \(found.map(\.name).joined(separator: ", ")).", false)
        case .noChrome:
            return ("Chrome isn't installed on this Mac, so there's nothing to copy.", false)
        case .noProfiles:
            return ("Chrome has no profiles with sign-ins to copy.", false)
        case .askingKeychain:
            return ("Waiting for you to allow conch in the macOS prompt…", false)
        case let .importing(profile, index, total, done, cookies):
            let counted = cookies > 0 ? " \(done.formatted()) of \(cookies.formatted())." : ""
            return ("Copying \(profile) (\(index + 1) of \(total))…\(counted)", false)
        case .denied:
            return ("conch wasn't allowed to read Chrome Safe Storage, so nothing was copied. Try again to be asked again.", true)
        case .keyMissing:
            return ("Chrome's key isn't in your Keychain. Open Chrome once, then try again.", true)
        case let .failed(error):
            return (error, true)
        case .finished:
            let imported = store.reports.reduce(0) { $0 + $1.imported }
            return ("Copied \(imported.formatted()) \(imported == 1 ? "cookie" : "cookies") from Chrome. Pages already open sign in when they reload.", false)
        }
    }
}

/// A Chrome profile, where it went, and its counts. Never a value.
private struct ChromeImportReportRow: View {
    let report: ChromeImport.Report

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(report.chrome.name)
                    .font(ConchTypography.font(size: 12.5, weight: .medium))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .lineLimit(1)
                Text(report.conchProfile.map { "Into \($0)" } ?? "Not imported")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
                    .lineLimit(1)
            }
            Spacer(minLength: ConchSpace.x3)
            if let problem = report.problem {
                Text(problem)
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.statusNeeds)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("\(report.imported.formatted()) imported · \(report.skipped.formatted()) skipped · \(report.failed.formatted()) failed")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
                    .monospacedDigit()
                    .help("Skipped: expired, or kept for one site only. Failed: couldn't be decrypted.")
            }
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
