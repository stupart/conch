import Foundation
import SwiftUI

// MARK: - What conch asks macOS for

/// The four macOS permissions conch uses, in the words the app shows for them.
///
/// Each one is granted once, to conch.app, and that one grant covers everything that needs it. macOS charges a process's
/// access to its *responsible* process, and a child inherits its parent's: the daemon conch.app starts, and the
/// `osascript` and `sox` the daemon runs, all answer to conch.app (docs/architecture.md, "One grant, to conch.app"). A
/// daemon started from a terminal answers to that terminal instead, which is why Settings says so
/// (`ConchPermissionHost`).
///
/// Settings lists these (`ConchPermissionList`), and onboarding shows the same rows.
public enum ConchPermission: String, CaseIterable, Identifiable, Sendable {
    case accessibility, automation, screenRecording, microphone

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .accessibility: "Accessibility"
        case .automation: "Automation"
        case .screenRecording: "Screen Recording"
        case .microphone: "Microphone"
        }
    }

    /// What it lets conch do, in plain words.
    public var purpose: String {
        switch self {
        case .accessibility:
            "Lets conch see which app and page you're on, and type your replies into Terminal."
        case .automation:
            "Lets conch find your session's Terminal window, bring it forward, and press keys there through System Events."
        case .screenRecording:
            "Lets conch take the picture you draw on and send, record a Show, and snapshot a window for your phone."
        case .microphone:
            "Lets conch hear your spoken replies. What you say is transcribed on this Mac and never uploaded."
        }
    }

    public var symbol: String {
        switch self {
        case .accessibility: "accessibility"
        case .automation: "gearshape.2"
        case .screenRecording: "rectangle.dashed.badge.record"
        case .microphone: "mic"
        }
    }

    /// Its list in System Settings › Privacy & Security, as the pane's own anchor names it.
    public var settingsAnchor: String {
        switch self {
        case .accessibility: "Privacy_Accessibility"
        case .automation: "Privacy_Automation"
        case .screenRecording: "Privacy_ScreenCapture"
        case .microphone: "Privacy_Microphone"
        }
    }

    /// System Settings, open at that list. The Privacy & Security pane still answers to its old preference-pane id, and
    /// takes these anchors, on macOS 13 and later.
    public var settingsURL: URL {
        URL(string: "x-apple.systempreferences:com.apple.preference.security?\(settingsAnchor)")!
    }
}

/// Where one permission stands for conch.
public enum ConchPermissionStatus: Equatable, Sendable {
    case granted
    /// Off, or never turned on. For Accessibility and Screen Recording macOS doesn't say which.
    case denied
    /// macOS hasn't asked yet, so there is nothing to turn on in System Settings until it does.
    case notAsked
    /// On in System Settings, but it reaches conch only once conch opens again.
    case needsRelaunch
    /// Set by whoever manages this Mac.
    case restricted
    /// Can't be read right now, and why.
    case unknown(String)

    public var label: String {
        switch self {
        case .granted: "Allowed"
        case .denied: "Not allowed"
        case .notAsked: "Not asked yet"
        case .needsRelaunch: "Allowed. Reopen conch to use it."
        case .restricted: "Set by whoever manages this Mac"
        case let .unknown(why): why
        }
    }

    /// The one thing to do about it, or nil when there is nothing conch can do.
    public var action: ConchPermissionAction? {
        switch self {
        case .denied: .openSettings
        case .notAsked: .ask
        case .needsRelaunch: .reopen
        case .granted, .restricted, .unknown: nil
        }
    }

    /// How the row marks it: allowed, a reopen from allowed, off, or nothing to say yet.
    public enum Tone: Equatable, Sendable { case good, almost, needsYou, quiet }

    public var tone: Tone {
        switch self {
        case .granted: .good
        // Allowed already: not attention's red, which would say something is wrong. The button says what is left.
        case .needsRelaunch: .almost
        case .denied: .needsYou
        case .notAsked, .restricted, .unknown: .quiet
        }
    }
}

/// The one button a permission gets.
public enum ConchPermissionAction: String, CaseIterable, Sendable {
    /// System Settings at the permission's own list.
    case openSettings
    /// macOS's own prompt, for a permission it hasn't asked about yet.
    case ask
    /// conch opens again, with the store's own relaunch.
    case reopen

    /// The canvas's words for the same two buttons (`CanvasToolPill.Notice.Action`), so conch says one thing one way.
    public var title: String {
        switch self {
        case .openSettings: "Open Settings"
        case .ask: "Allow…"
        case .reopen: "Reopen conch"
        }
    }
}

// MARK: - Reading what macOS says

/// macOS's raw answers, turned into a status. The Mac app gathers the answers, silently; these decide what they mean.
public enum ConchPermissionReading {
    /// `AXIsProcessTrusted()`, and whether Accessibility then answered conch at all: a trusted process it still refuses
    /// (`kAXErrorAPIDisabled`) was trusted after it started, and gets it on reopening. Nil when that wasn't asked.
    public static func accessibility(trusted: Bool, answered: Bool?) -> ConchPermissionStatus {
        guard trusted else { return .denied }
        return answered == false ? .needsRelaunch : .granted
    }

    /// `CGPreflightScreenCaptureAccess()` in conch itself, and in a process started just now. A running app keeps the
    /// answer it started with; a new process of conch's gets today's, so the two disagreeing means a reopen away. Nil
    /// when the new process couldn't say.
    public static func screenRecording(thisProcess: Bool, newProcess: Bool?) -> ConchPermissionStatus {
        if thisProcess { return .granted }
        return newProcess == true ? .needsRelaunch : .denied
    }

    /// `AVCaptureDevice.authorizationStatus(for: .audio)`, by its raw value.
    public static func microphone(_ raw: Int) -> ConchPermissionStatus {
        switch raw {
        case 0: .notAsked
        case 1: .restricted
        case 2: .denied
        case 3: .granted
        default: .unknown("macOS gave an answer conch doesn't know.")
        }
    }

    /// `AEDeterminePermissionToAutomateTarget` for each app conch sends Apple Events to, asked never to prompt. macOS
    /// answers only for an app that is running, so one that isn't leaves the answer open.
    public static func automation(_ answers: [(app: String, status: Int32)]) -> ConchPermissionStatus {
        let running = answers.filter { $0.status != procNotFound }
        if running.contains(where: { $0.status == notPermitted }) { return .denied }
        if running.contains(where: { $0.status == wouldRequireConsent }) { return .notAsked }
        let closed = answers.filter { $0.status == procNotFound }.map(\.app)
        if !closed.isEmpty {
            let names = closed.count == 1 ? closed[0] : closed.dropLast().joined(separator: ", ") + " and " + closed.last!
            return .unknown("\(names) \(closed.count == 1 ? "isn't" : "aren't") open, so macOS can't say yet.")
        }
        if !running.isEmpty, running.allSatisfy({ $0.status == 0 }) { return .granted }
        return .unknown("macOS didn't say.")
    }

    /// `errAEEventNotPermitted`, `errAEEventWouldRequireUserConsent` and `procNotFound`, from CoreServices.
    public static let notPermitted: Int32 = -1743
    public static let wouldRequireConsent: Int32 = -1744
    public static let procNotFound: Int32 = -600
}

// MARK: - When something stopped for want of one

/// A feature that stopped, or went quiet, because conch lacks a permission: what the app says about it where it happened.
/// In the order they are worth saying: the first that applies is the one shown.
public enum ConchPermissionTrouble: String, CaseIterable, Sendable {
    /// The daemon's keystrokes were refused (`accessibility-permission-denied`).
    case typing
    /// The daemon's Apple Events to Terminal or System Events were refused (`automation-permission-denied`).
    case controlling
    /// The microphone is off for conch, so the daemon's recorder hears silence.
    case hearing
    /// A picture of the screen was refused.
    case screen
    /// Without Accessibility the front-window observer knows only which app is in front.
    case screenContext

    public var permission: ConchPermission {
        switch self {
        case .typing, .screenContext: .accessibility
        case .controlling: .automation
        case .hearing: .microphone
        case .screen: .screenRecording
        }
    }

    /// In conch's voice: what couldn't happen, and where to fix it.
    public var line: String {
        switch self {
        case .typing: "conch can't type into Terminal: allow conch in Accessibility."
        case .controlling: "conch can't control Terminal: allow conch in Automation."
        case .hearing: "conch can't hear you: allow conch in Microphone."
        case .screen: "conch can't see your screen: allow conch in Screen Recording."
        case .screenContext: "conch sees only which app is in front: allow conch in Accessibility to see the page or document too."
        }
    }

    /// The trouble a send's failure names, from the daemon's own code (`src/inject.ts`); nil for any other reason.
    public init?(sendFailure reason: String?) {
        switch reason {
        case "accessibility-permission-denied": self = .typing
        case "automation-permission-denied": self = .controlling
        default: return nil
        }
    }

    /// The daemon's: macOS asks whoever started the daemon about these, which is conch only when conch started it.
    public var isDaemons: Bool { self == .typing || self == .controlling || self == .hearing }
}

/// The line the app shows for a trouble, with its one button.
public struct ConchPermissionNotice: Equatable, Sendable {
    public let trouble: ConchPermissionTrouble
    public let text: String
    public let action: ConchPermissionAction?

    public var permission: ConchPermission { trouble.permission }

    public init(trouble: ConchPermissionTrouble, status: ConchPermissionStatus) {
        self.trouble = trouble
        switch status {
        case .needsRelaunch:
            text = "\(trouble.permission.title) is on for conch: reopen conch to finish."
            action = .reopen
        case .restricted:
            text = trouble.line
            action = nil
        case .notAsked:
            text = trouble.line
            action = .ask
        case .granted, .denied, .unknown:
            text = trouble.line
            action = .openSettings
        }
    }

    /// The notice to show now, if any.
    ///
    /// `noted` are the troubles that happened this launch (a send refused), newest last; a missing Accessibility grant
    /// and a microphone turned off are troubles whenever they hold, since everything that needs them is quietly failing.
    /// A permission that is granted now has fixed its trouble. `daemonIsConchs` is false when the daemon was started by
    /// something else: macOS asks that, not conch, so conch's own grants say nothing about the daemon's troubles.
    public static func current(
        noted: [ConchPermissionTrouble],
        statuses: [ConchPermission: ConchPermissionStatus],
        dismissed: Set<ConchPermissionTrouble> = [],
        daemonIsConchs: Bool
    ) -> ConchPermissionNotice? {
        var troubles = Set(noted)
        if statuses[.microphone] == .denied { troubles.insert(.hearing) }
        if let accessibility = statuses[.accessibility], accessibility == .denied || accessibility == .needsRelaunch {
            troubles.insert(.screenContext)
        }
        for trouble in ConchPermissionTrouble.allCases where troubles.contains(trouble) {
            if dismissed.contains(trouble) || (trouble.isDaemons && !daemonIsConchs) { continue }
            let status = statuses[trouble.permission] ?? .unknown("")
            if status == .granted { continue }
            return ConchPermissionNotice(trouble: trouble, status: status)
        }
        return nil
    }
}

/// Who macOS asks when the daemon types and listens: whoever started it.
public enum ConchPermissionHost {
    /// A caution for Settings when that isn't conch; nil when it is, or when nobody knows. `startedBy` is the daemon's
    /// own record of it (`daemon-identity.ts`): "app", "terminal" or "launchd".
    public static func caution(startedBy: String?) -> String? {
        switch startedBy {
        case "terminal":
            "conch's daemon was started from a terminal, so macOS checks that terminal's permissions when it types and listens, not conch's. Stop it there, and conch starts its own."
        case "launchd":
            "conch's daemon was started by the launchd service, so macOS checks bun's permissions when it types and listens, not conch's. Let the app own it to use conch's."
        default:
            nil
        }
    }
}

// MARK: - On screen

/// The one button, as the canvas pill's notice draws its first: ink, in a capsule.
public struct ConchPermissionButton: View {
    let action: ConchPermissionAction
    let font: Font
    let height: CGFloat
    let run: () -> Void

    public init(_ action: ConchPermissionAction, font: Font = ConchType.secondary.weight(.semibold), height: CGFloat = 24, run: @escaping () -> Void) {
        self.action = action
        self.font = font
        self.height = height
        self.run = run
    }

    public var body: some View {
        Button(action: run) {
            Text(action.title)
                .font(font)
                .foregroundStyle(ConchColor.onAccent)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 11)
                .frame(height: height)
                .background(Capsule().fill(ConchColor.accent))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// One permission as Settings and onboarding show it: what it is for, where it stands, and the one thing to do about it.
public struct ConchPermissionRow: View {
    let permission: ConchPermission
    let status: ConchPermissionStatus
    /// Something that went wrong doing the one thing: a reopen that didn't happen, Settings that wouldn't open.
    let note: String?
    let titleFont: Font
    let detailFont: Font
    let statusFont: Font
    let onAction: (ConchPermissionAction) -> Void

    public init(
        permission: ConchPermission,
        status: ConchPermissionStatus,
        note: String? = nil,
        titleFont: Font = ConchType.uiEmphasis,
        detailFont: Font = ConchType.secondary,
        statusFont: Font = ConchType.meta,
        onAction: @escaping (ConchPermissionAction) -> Void
    ) {
        self.permission = permission
        self.status = status
        self.note = note
        self.titleFont = titleFont
        self.detailFont = detailFont
        self.statusFont = statusFont
        self.onAction = onAction
    }

    public var body: some View {
        HStack(alignment: .center, spacing: ConchSpace.x4) {
            Image(systemName: permission.symbol)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(ConchColor.textSecondary)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(permission.title)
                    .font(titleFont)
                    .foregroundStyle(ConchColor.textPrimary)
                Text(permission.purpose)
                    .font(detailFont)
                    .foregroundStyle(ConchColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Self.mark(status.tone)
                    Text(status.label)
                        .font(statusFont)
                        .foregroundStyle(status.tone == .needsYou ? AnyShapeStyle(ConchColor.attention) : AnyShapeStyle(ConchColor.textSecondary))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 1)
                if let note {
                    Text(note)
                        .font(statusFont)
                        .foregroundStyle(ConchColor.attention)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let action = status.action {
                ConchPermissionButton(action, height: 26) { onAction(action) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(permission.title): \(status.label)")
    }

    /// The dot before the status: ready's green when allowed, its ring when a reopen away, attention's when off.
    @ViewBuilder
    static func mark(_ tone: ConchPermissionStatus.Tone) -> some View {
        switch tone {
        case .good: Circle().fill(ConchColor.ready).frame(width: 7, height: 7)
        case .almost: Circle().strokeBorder(ConchColor.ready, lineWidth: 1.5).frame(width: 7, height: 7)
        case .needsYou: Circle().fill(ConchColor.attention).frame(width: 7, height: 7)
        case .quiet: Circle().fill(ConchColor.quiet).frame(width: 7, height: 7)
        }
    }
}

/// Every permission, one row each, under whatever caution applies to who macOS is asking.
public struct ConchPermissionList: View {
    let statuses: [ConchPermission: ConchPermissionStatus]
    let notes: [ConchPermission: String]
    let caution: String?
    let cautionAction: (title: String, run: () -> Void)?
    let titleFont: Font
    let detailFont: Font
    let statusFont: Font
    let inset: CGFloat
    let onAction: (ConchPermission, ConchPermissionAction) -> Void

    public init(
        statuses: [ConchPermission: ConchPermissionStatus],
        notes: [ConchPermission: String] = [:],
        caution: String? = nil,
        cautionAction: (title: String, run: () -> Void)? = nil,
        titleFont: Font = ConchType.uiEmphasis,
        detailFont: Font = ConchType.secondary,
        statusFont: Font = ConchType.meta,
        inset: CGFloat = ConchSpace.x5,
        onAction: @escaping (ConchPermission, ConchPermissionAction) -> Void
    ) {
        self.statuses = statuses
        self.notes = notes
        self.caution = caution
        self.cautionAction = cautionAction
        self.titleFont = titleFont
        self.detailFont = detailFont
        self.statusFont = statusFont
        self.inset = inset
        self.onAction = onAction
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let caution {
                HStack(alignment: .center, spacing: ConchSpace.x3) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ConchColor.attention)
                    Text(caution)
                        .font(detailFont)
                        .foregroundStyle(ConchColor.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let cautionAction {
                        Button(action: cautionAction.run) {
                            Text(cautionAction.title)
                                .font(ConchType.secondary.weight(.semibold))
                                .foregroundStyle(ConchColor.onAccent)
                                .fixedSize()
                                .padding(.horizontal, 11)
                                .frame(height: 26)
                                .background(Capsule().fill(ConchColor.accent))
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, inset)
                .padding(.vertical, ConchSpace.x3)
                .background(ConchColor.surfaceRaised)
                Rectangle().fill(ConchColor.hairline).frame(height: 1)
            }
            ForEach(Array(ConchPermission.allCases.enumerated()), id: \.element) { index, permission in
                if index > 0 {
                    Rectangle().fill(ConchColor.hairline).frame(height: 1).padding(.horizontal, inset)
                }
                ConchPermissionRow(
                    permission: permission,
                    status: statuses[permission] ?? .unknown("Checking…"),
                    note: notes[permission],
                    titleFont: titleFont,
                    detailFont: detailFont,
                    statusFont: statusFont,
                    onAction: { onAction(permission, $0) }
                )
                .padding(.horizontal, inset)
                .padding(.vertical, 15)
            }
        }
    }
}

/// A trouble's line, as a bar in conch's window: the permission's mark, the words, its one button, and a way to put it
/// away until it happens again.
public struct ConchPermissionNoticeBar: View {
    let notice: ConchPermissionNotice
    let font: Font
    let onAction: (ConchPermissionAction) -> Void
    let onDismiss: (() -> Void)?

    public init(
        notice: ConchPermissionNotice,
        font: Font = ConchType.secondary,
        onAction: @escaping (ConchPermissionAction) -> Void,
        onDismiss: (() -> Void)? = nil
    ) {
        self.notice = notice
        self.font = font
        self.onAction = onAction
        self.onDismiss = onDismiss
    }

    public var body: some View {
        HStack(spacing: 10) {
            Image(systemName: notice.permission.symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchColor.attention)
                .accessibilityHidden(true)
            Text(notice.text)
                .font(font)
                .foregroundStyle(ConchColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let action = notice.action {
                ConchPermissionButton(action, font: ConchType.meta.weight(.semibold), height: 22) { onAction(action) }
            }
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundStyle(ConchColor.textSecondary)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConchColor.surfaceRaised)
    }
}
