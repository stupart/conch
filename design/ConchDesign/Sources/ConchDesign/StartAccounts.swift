import Foundation
import SwiftUI

/// The same account reply is used locally and over the paired Mac's bridge.
/// Credentials and configuration paths are deliberately not needed by this UI.
public struct StartAccountCatalog: Decodable {
    public var accounts: [StartAccountProfile]
    public var usage: StartAccountUsageDashboard?
    public init(accounts: [StartAccountProfile], usage: StartAccountUsageDashboard? = nil) {
        self.accounts = accounts
        self.usage = usage
    }

    public func usage(for id: String) -> StartAccountUsage? { usage?.accounts.first { $0.id == id } }
    public func availability(for id: String, now: Date, sourceAccountId: String? = nil) -> StartAccountAvailability {
        guard let account = accounts.first(where: { $0.id == id }) else { return .missing }
        if let sourceAccountId, sourceAccountId != id, account.status != "signed-in" { return .signIn }
        return StartAccountAvailability.evaluate(account: account, usage: usage(for: id), now: now)
    }
}

public struct StartAccountProfile: Decodable, Identifiable {
    public let id: String
    public let label: String
    public let status: String
    public let email: String?
    public let subscription: String?
    public init(id: String, label: String, status: String, email: String? = nil, subscription: String? = nil) {
        self.id = id; self.label = label; self.status = status; self.email = email; self.subscription = subscription
    }
}

public struct StartAccountUsageDashboard: Decodable {
    public let accounts: [StartAccountUsage]
    public init(accounts: [StartAccountUsage]) { self.accounts = accounts }
}

public struct StartAccountUsage: Decodable {
    public let id: String
    public let status: String
    public let windows: [StartAccountWindow]
    public let fetchedAt: String?
    public let lastGood: Bool
    public init(id: String, status: String, windows: [StartAccountWindow], fetchedAt: String?, lastGood: Bool) {
        self.id = id; self.status = status; self.windows = windows; self.fetchedAt = fetchedAt; self.lastGood = lastGood
    }
    public func isFresh(at now: Date) -> Bool {
        guard !lastGood, let fetched = StartAccountWindow.date(fetchedAt) else { return false }
        return (-60...300).contains(now.timeIntervalSince(fetched))
    }
}

public struct StartAccountWindow: Decodable {
    public let name: String
    public let pct: Double
    public let resetsAt: String?
    public init(name: String, pct: Double, resetsAt: String?) { self.name = name; self.pct = pct; self.resetsAt = resetsAt }
    public var reset: Date? { Self.date(resetsAt) }
    public var validPercentage: Bool { pct.isFinite && (0...100).contains(pct) }
    /// Named model buckets never establish that the entire account is empty.
    public var isPlanWindow: Bool { !name.contains("·") }
    public static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

public enum StartAccountAvailability: Equatable {
    case missing, signIn, unknown, stale, reported, apiBilling
    case limitReached(Date)

    public func blocksStart(allowAtLimit: Bool) -> Bool {
        switch self {
        case .missing, .signIn: return true
        case .limitReached: return !allowAtLimit
        default: return false
        }
    }
    public var label: String {
        switch self {
        case .missing: return "Account unavailable"
        case .signIn: return "Sign in needed"
        case .unknown: return "Usage unknown"
        case .stale: return "Last reported usage"
        case .reported: return "Usage reported"
        case .apiBilling: return "API billing"
        case .limitReached: return "Plan at limit"
        }
    }
    public static func evaluate(account: StartAccountProfile, usage: StartAccountUsage?, now: Date) -> Self {
        if account.status == "signed-out" { return .signIn }
        guard let usage else { return .unknown }
        if ["no_credentials", "token_expired", "relogin_required"].contains(usage.status) { return .signIn }
        if usage.status == "api_key" { return .apiBilling }
        guard usage.status == "ok" else { return .unknown }
        let windows = usage.windows.filter { $0.validPercentage && $0.isPlanWindow }
        guard !windows.isEmpty else { return .unknown }
        guard usage.isFresh(at: now) else { return .stale }
        let blocked = windows.filter { $0.pct >= 100 && ($0.reset.map { $0 > now } ?? false) }
        // Every exhausted window must reset before the included plan can run again.
        if let reset = blocked.compactMap(\.reset).max() { return .limitReached(reset) }
        guard windows.allSatisfy({ $0.reset.map { $0 > now } ?? false }) else { return .unknown }
        return .reported
    }
}

/// One compact identity and its usage; expanding reveals each alternative's
/// capacity before selection. Used by both native start sheets.
public struct StartAccountPicker: View {
    public let catalog: StartAccountCatalog
    public let provider: String
    @Binding public var selection: String
    public var now: Date
    public var allowAtLimit: Bool
    public var locked: Bool
    public var providerMark: Image?
    public var sourceAccountId: String?
    @State private var expanded = false

    public init(catalog: StartAccountCatalog, provider: String, selection: Binding<String>, now: Date,
                allowAtLimit: Bool = false, locked: Bool = false, providerMark: Image? = nil, sourceAccountId: String? = nil) {
        self.catalog = catalog; self.provider = provider; self._selection = selection
        self.now = now; self.allowAtLimit = allowAtLimit; self.locked = locked
        self.providerMark = providerMark
        self.sourceAccountId = sourceAccountId
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let selected = catalog.accounts.first(where: { $0.id == selection }) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 12) {
                        identity(selected)
                        Spacer(minLength: 4)
                        if !locked && catalog.accounts.count > 1 {
                            Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption)
                        }
                    }
                    .contentShape(Rectangle())
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
                .disabled(locked || catalog.accounts.count < 2)
                .accessibilityLabel("Account: \(selected.email ?? selected.label)")
                .accessibilityHint(locked ? "This session uses its original account" : "Show account choices and usage")
                usage(selected)
            } else {
                Text("Account unavailable. Refresh or manage accounts.")
                    .font(.callout).foregroundStyle(ConchColor.textSecondary)
                if !expanded && !catalog.accounts.isEmpty {
                    Button("Choose an account") { expanded = true }
                }
            }
            if expanded && !locked {
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(catalog.accounts) { account in
                            let blocked = catalog.availability(for: account.id, now: now, sourceAccountId: sourceAccountId).blocksStart(allowAtLimit: allowAtLimit)
                            Button {
                                selection = account.id
                                expanded = false
                            } label: {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack {
                                        identity(account)
                                        Spacer(minLength: 4)
                                        if account.id == selection { Image(systemName: "checkmark").font(.caption) }
                                        else if blocked { Image(systemName: "minus.circle").font(.caption) }
                                    }
                                    usage(account)
                                }
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(account.id == selection ? ConchColor.fillSelected : ConchColor.fill,
                                            in: RoundedRectangle(cornerRadius: 10))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(blocked)
                        }
                    }
                }
                .frame(maxHeight: 260)
            }
        }
        .foregroundStyle(ConchColor.textPrimary)
        .onChange(of: provider) { _, _ in expanded = false }
    }

    private func identity(_ account: StartAccountProfile) -> some View {
        HStack(spacing: 10) {
            (providerMark ?? Image(provider == "codex" ? "AgentCodex" : "AgentClaude"))
                .resizable().scaledToFit().frame(width: 24, height: 24).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(account.email ?? account.label).font(.callout.weight(.medium))
                    .lineLimit(2).textSelection(.disabled)
                Text([account.label, account.subscription].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(ConchColor.textSecondary)
            }
        }
    }

    private func usage(_ account: StartAccountProfile) -> some View {
        let reading = catalog.usage(for: account.id)
        let availability = catalog.availability(for: account.id, now: now, sourceAccountId: sourceAccountId)
        let windows = reading?.windows.filter { $0.validPercentage } ?? []
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(windows.enumerated()), id: \.offset) { _, window in
                let expired = window.reset.map { $0 <= now } ?? false
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(window.name.replacingOccurrences(of: "5 hour", with: "5h").replacingOccurrences(of: "7 day", with: "7d"))
                        Spacer()
                        Text(expired ? "Awaiting update" : "\(Int(window.pct.rounded()))% used")
                    }
                    .font(.caption).foregroundStyle(ConchColor.textSecondary)
                    GeometryReader { geometry in
                        Capsule().fill(ConchColor.fill)
                        Capsule().fill(window.pct >= 100 ? ConchColor.removed : ConchColor.textSecondary)
                            .frame(width: geometry.size.width * min(1, max(0, window.pct / 100)))
                            .opacity(expired || reading?.isFresh(at: now) != true ? 0.45 : 1)
                    }
                    .frame(height: 4).accessibilityHidden(true)
                    if let reset = window.reset, !expired {
                        Text("Resets in \(reset, style: .relative)")
                            .font(.caption2).foregroundStyle(ConchColor.textSecondary)
                    }
                }
            }
            HStack(spacing: 5) {
                if availability.blocksStart(allowAtLimit: false) { Image(systemName: "minus.circle") }
                Text(availability.label)
                if availability == .stale { Text("· refresh to check") }
            }
            .font(.caption)
            .foregroundStyle(availability.blocksStart(allowAtLimit: false) ? ConchColor.removed : ConchColor.textSecondary)
            if case .limitReached = availability {
                Text(allowAtLimit ? "Using your existing extra usage or credits, if available." : "Choose another account or wait for the reset.")
                    .font(.caption).foregroundStyle(ConchColor.textSecondary)
            }
        }
    }
}
