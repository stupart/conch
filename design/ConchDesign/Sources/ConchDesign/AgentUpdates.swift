import SwiftUI

/// Keeping the agent CLIs up to date (src/agent-updates.ts, Tyler 2026-11-09: "can we have a way for this to happen through
/// conch automatically?"). Settings › Providers shows each agent's version, how it's installed and when it was last looked
/// at, the last failure if there was one, an "Update now", and one "Update automatically" for all of them. It only ever
/// says when running sessions are behind: a session is never restarted to pick up a new version, the Mac's or conch's.

/// `{ kind: "agent-updates", action: "status" | "update-now", backend? }`.
public struct AgentUpdatesRequest: Encodable, Equatable, Sendable {
    public var kind = "agent-updates"
    public var action: String
    public var backend: String?

    public static let status = AgentUpdatesRequest(action: "status")
    public static func updateNow(_ backend: String) -> AgentUpdatesRequest { AgentUpdatesRequest(action: "update-now", backend: backend) }

    public init(action: String, backend: String? = nil) {
        self.action = action
        self.backend = backend
    }
}

public struct AgentUpdatesReply: Decodable, Equatable, Sendable {
    public let kind: String
    public let auto: Bool
    public let agents: [AgentUpdateRow]
}

/// What the daemon said about one agent's CLI (`AgentUpdatesRow`, src/agent-updates-wire.ts). Everything past `backend` may be
/// absent from a newer daemon's reply; a row reads leniently, as the session rows do.
public struct AgentUpdateRow: Decodable, Identifiable, Equatable, Sendable {
    public let backend: String
    public let displayName: String
    public let channel: String
    public let source: String
    public let installed: String?
    public let newest: String?
    public let cask: String?
    public let checkedAt: Double?
    public let updatedAt: Double?
    public let updatedFrom: String?
    public let updatedTo: String?
    public let failure: Failure?
    public let canUpdate: Bool
    public let updating: Bool
    public let olderSessions: OlderSessions

    public var id: String { backend }

    public struct Failure: Decodable, Equatable, Sendable {
        public let at: Double
        public let phase: String
        public let message: String
        public let output: String?
    }

    public struct OlderSessions: Decodable, Equatable, Sendable {
        public let count: Int
        public let versions: [String]

        public init(count: Int, versions: [String]) {
            self.count = count
            self.versions = versions
        }
    }

    private enum CodingKeys: String, CodingKey {
        case backend, displayName, channel, source, installed, newest, cask, checkedAt, updatedAt, updatedFrom, updatedTo, failure, canUpdate, updating, olderSessions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        backend = try c.decode(String.self, forKey: .backend)
        displayName = (try? c.decode(String.self, forKey: .displayName)) ?? backend
        channel = (try? c.decode(String.self, forKey: .channel)) ?? "not-managed"
        source = (try? c.decode(String.self, forKey: .source)) ?? ""
        installed = try? c.decodeIfPresent(String.self, forKey: .installed)
        newest = try? c.decodeIfPresent(String.self, forKey: .newest)
        cask = try? c.decodeIfPresent(String.self, forKey: .cask)
        checkedAt = try? c.decodeIfPresent(Double.self, forKey: .checkedAt)
        updatedAt = try? c.decodeIfPresent(Double.self, forKey: .updatedAt)
        updatedFrom = try? c.decodeIfPresent(String.self, forKey: .updatedFrom)
        updatedTo = try? c.decodeIfPresent(String.self, forKey: .updatedTo)
        failure = try? c.decodeIfPresent(Failure.self, forKey: .failure)
        canUpdate = (try? c.decode(Bool.self, forKey: .canUpdate)) ?? false
        updating = (try? c.decode(Bool.self, forKey: .updating)) ?? false
        olderSessions = (try? c.decode(OlderSessions.self, forKey: .olderSessions)) ?? OlderSessions(count: 0, versions: [])
    }

    public init(
        backend: String, displayName: String, channel: String = "homebrew-cask", source: String = "",
        installed: String? = nil, newest: String? = nil, cask: String? = nil, checkedAt: Double? = nil,
        updatedAt: Double? = nil, updatedFrom: String? = nil, updatedTo: String? = nil, failure: Failure? = nil,
        canUpdate: Bool = true, updating: Bool = false, olderSessions: OlderSessions = OlderSessions(count: 0, versions: [])
    ) {
        self.backend = backend
        self.displayName = displayName
        self.channel = channel
        self.source = source
        self.installed = installed
        self.newest = newest
        self.cask = cask
        self.checkedAt = checkedAt
        self.updatedAt = updatedAt
        self.updatedFrom = updatedFrom
        self.updatedTo = updatedTo
        self.failure = failure
        self.canUpdate = canUpdate
        self.updating = updating
        self.olderSessions = olderSessions
    }
}

public enum AgentUpdates {
    public static let toggleTitle = "Update automatically"
    public static let toggleCaption = "Checks every few hours and updates Claude Code and Codex when they're Homebrew casks. A running session stays on the version it started with."

    /// How long ago, in the words Settings › Logins uses: "3 min ago", "5 h ago", "2 days ago", "just now".
    public static func ago(_ ms: Double, now: Date = Date()) -> String {
        let minutes = Int((now.timeIntervalSince1970 * 1000 - ms) / 60_000)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60
        return hours < 48 ? "\(hours) h ago" : "\(hours / 24) days ago"
    }

    /// Whether the newest version seen is newer than the one installed, the way the daemon reads it: only `x.y.z` on both.
    public static func isBehind(_ row: AgentUpdateRow) -> Bool {
        guard let newest = row.newest, let installed = row.installed,
              let latest = version(newest), let current = version(installed) else { return false }
        return latest.lexicographicallyPrecedes(current) == false && latest != current
    }

    private static func version(_ text: String) -> [Int]? {
        let parts = text.split(separator: ".").compactMap { Int($0) }
        return parts.count == 3 ? parts : nil
    }

    /// Under the name: how it's installed, and for one conch manages, the newest it has seen and when it looked.
    public static func installLine(_ row: AgentUpdateRow, now: Date = Date()) -> String {
        guard row.canUpdate else { return row.source }
        var parts = [row.source]
        if let newest = row.newest {
            parts.append(isBehind(row) ? "\(newest) available" : "Up to date")
        }
        if let checkedAt = row.checkedAt { parts.append("Checked \(ago(checkedAt, now: now))") }
        return parts.joined(separator: " · ")
    }

    /// What it last did, for a CLI conch manages. Nil before its first update.
    public static func lastUpdate(_ row: AgentUpdateRow, now: Date = Date()) -> String? {
        guard let updatedAt = row.updatedAt, let from = row.updatedFrom, let to = row.updatedTo else { return nil }
        return "Updated \(from) → \(to), \(ago(updatedAt, now: now))"
    }

    public static func failureLine(_ failure: AgentUpdateRow.Failure, now: Date = Date()) -> String {
        let lead = failure.phase == "check" ? "Couldn't check for a new version" : "Couldn't update"
        return "\(lead) \(ago(failure.at, now: now)): \(failure.message)"
    }

    /// The quiet note: sessions already running stay where they are until they end. Never "will restart".
    public static func olderSessionsLine(_ row: AgentUpdateRow) -> String? {
        guard row.olderSessions.count > 0, let installed = row.installed else { return nil }
        let count = row.olderSessions.count
        let on = row.olderSessions.versions.count == 1 ? row.olderSessions.versions[0] : "older versions"
        let who = count == 1 ? "1 running session is" : "\(count) running sessions are"
        return "\(who) still on \(on). They move to \(installed) when you restart them; conch won't."
    }

    /// The label on the row's button while the daemon says it's updating.
    public static let updatingLabel = "Updating…"
}

/// One agent's row: its mark, its name and version, how it's installed, the last thing that happened, and Update now.
public struct AgentUpdateRowView: View {
    public static let markSide: CGFloat = 26

    let row: AgentUpdateRow
    let now: Date
    let onUpdate: () -> Void
    let mark: Image?

    public init(row: AgentUpdateRow, now: Date = Date(), mark: Image? = nil, onUpdate: @escaping () -> Void) {
        self.row = row
        self.now = now
        self.mark = mark
        self.onUpdate = onUpdate
    }

    /// The name's line, as the card measures it: where the cap-height centre of its 12.5-point type sits below its first
    /// baseline, so the mark and the button are centred on the name rather than on the top of a row that can run to five lines.
    private static let nameCapCentre: CGFloat = 4.5

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x3) {
            markView.alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + Self.nameCapCentre }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(row.displayName).font(.system(size: 12.5, weight: .medium)).foregroundStyle(ConchColor.textPrimary)
                    if let installed = row.installed {
                        Text(installed).font(.system(size: 11, design: .monospaced)).foregroundStyle(ConchColor.textSecondary).textSelection(.enabled)
                    }
                }
                Text(AgentUpdates.installLine(row, now: now))
                    .font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let update = AgentUpdates.lastUpdate(row, now: now) {
                    Text(update).font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary)
                }
                if let failure = row.failure {
                    Text(AgentUpdates.failureLine(failure, now: now))
                        .font(.system(size: 11)).foregroundStyle(ConchColor.attention)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .help(failure.output ?? failure.message)
                }
                if let older = AgentUpdates.olderSessionsLine(row) {
                    Text(older).font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            control.alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + Self.nameCapCentre }
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var markView: some View {
        if let mark {
            mark.resizable().scaledToFit().frame(width: Self.markSide, height: Self.markSide)
        } else {
            Color.clear.frame(width: Self.markSide, height: Self.markSide)
        }
    }

    @ViewBuilder
    private var control: some View {
        if row.updating {
            HStack(spacing: ConchSpace.x2) {
                ProgressView().controlSize(.small)
                Text(AgentUpdates.updatingLabel).font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary)
            }
        } else if row.canUpdate {
            Button("Update now", action: onUpdate)
                .controlSize(.small)
                .help("Checks for a newer version and installs it through Homebrew. A running session stays on the version it started with.")
        }
    }
}

/// Every agent, and the one switch that covers them all: `agent-auto-update`, one setting for the daemon, one here.
public struct AgentUpdatesCard<Marks: AgentUpdateMarks>: View {
    let reply: AgentUpdatesReply
    let now: Date
    let marks: Marks
    let onUpdate: (String) -> Void
    let onSetAuto: (Bool) -> Void

    public init(reply: AgentUpdatesReply, now: Date = Date(), marks: Marks, onUpdate: @escaping (String) -> Void, onSetAuto: @escaping (Bool) -> Void) {
        self.reply = reply
        self.now = now
        self.marks = marks
        self.onUpdate = onUpdate
        self.onSetAuto = onSetAuto
    }

    public var body: some View {
        OnboardingCard {
            ForEach(Array(reply.agents.enumerated()), id: \.element.id) { index, row in
                if index > 0 { OnboardingDivider(leading: Self.wordsEdge) }
                AgentUpdateRowView(row: row, now: now, mark: marks.mark(row.backend)) { onUpdate(row.backend) }
            }
            OnboardingDivider(leading: Self.wordsEdge)
            HStack(spacing: ConchSpace.x3) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(AgentUpdates.toggleTitle).font(.system(size: 12.5, weight: .medium)).foregroundStyle(ConchColor.textPrimary)
                    Text(AgentUpdates.toggleCaption).font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: ConchSpace.x3)
                Toggle("", isOn: Binding(get: { reply.auto }, set: onSetAuto))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .accessibilityLabel(AgentUpdates.toggleTitle)
            }
            // Its words start where every agent's name does, past the marks' column, as a card row's words do (FailureTickets).
            .padding(.leading, AgentUpdateRowView.markSide + ConchSpace.x3)
            .padding(.horizontal, ConchSpace.x4)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Where a row's words start: the card's inset, the marks' column, and the gap after it. Every hairline starts here.
    private static var wordsEdge: CGFloat { ConchSpace.x4 + AgentUpdateRowView.markSide + ConchSpace.x3 }
}

/// Each agent's mark, from the host's own bundle: the design package has no agent art of its own.
public protocol AgentUpdateMarks {
    func mark(_ backend: String) -> Image?
}
