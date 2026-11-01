import Foundation
import SwiftUI

/// A Claude subscription one session can sign in as (daemon `claude-session-sign-ins.ts`): conch's name for it and when
/// it was added. 2026-11-01, Tyler: "one profile, choose which account a new session signs in as". Its token is in this
/// Mac's Keychain and read by the session's own shell as it starts; nothing here ever holds one.
public struct ClaudeSessionSignIn: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    /// Epoch milliseconds, as the daemon writes it.
    public let addedAt: Double

    public init(id: String, label: String, addedAt: Double) {
        self.id = id
        self.label = label
        self.addedAt = addedAt
    }

    public var added: Date { Date(timeIntervalSince1970: addedAt / 1000) }
}

/// The daemon's answer to every `claude-session-sign-ins` request: the list as it is now, and what the request did.
public struct ClaudeSessionSignInsReply: Decodable, Equatable, Sendable {
    public let signIns: [ClaudeSessionSignIn]
    /// The sign-in an `add` made.
    public let added: String?
    /// `setup` opened Terminal on `claude setup-token`.
    public let setupOpened: Bool?
}

/// Which sign-in a new session starts on. Offered for Claude in the Default profile only, where the alternative is
/// Default's own login, the one that moves between your accounts; another profile has a login of its own.
public enum SessionSignInChoice {
    /// No sign-in: Default's own login.
    public static let rotating = "Default · rotating"

    public static func offered(backend: String, accountId: String?, signIns: [ClaudeSessionSignIn]) -> Bool {
        backend == "claude" && (accountId ?? "default") == "default" && !signIns.isEmpty
    }

    /// What the picker shows: the chosen sign-in while it is still listed, else the rotating login. What is shown is
    /// what is sent (`sent`), so a sign-in removed while the sheet was open never starts a session without a word.
    public static func shown(selection: String?, signIns: [ClaudeSessionSignIn]) -> String? {
        guard let selection, signIns.contains(where: { $0.id == selection }) else { return nil }
        return selection
    }

    /// The `claudeSignInId` a start sends: the shown sign-in, when the choice is offered at all.
    public static func sent(selection: String?, backend: String, accountId: String?, signIns: [ClaudeSessionSignIn]) -> String? {
        guard offered(backend: backend, accountId: accountId, signIns: signIns) else { return nil }
        return shown(selection: selection, signIns: signIns)
    }
}

/// What the sheet takes from a paste of `claude setup-token`'s token, as the daemon checks it. A copy from Terminal may
/// carry the line breaks (and indent) of a token wrapped across lines, so each line is trimmed and they are joined; a
/// space inside a line is never a token's, and refuses it. Loose about what follows `sk-ant-<kind>-`, strict about what
/// can't be in a token.
public enum SessionSignInToken {
    public static func normalized(_ pasted: String) -> String? {
        let token = pasted.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.joined()
        guard token.count <= 1_024, token.hasPrefix("sk-ant-") else { return nil }
        let rest = token.dropFirst("sk-ant-".count)
        guard let dash = rest.firstIndex(of: "-") else { return nil }
        let kind = rest[..<dash]
        let body = rest[rest.index(after: dash)...]
        let lowercase = Set("abcdefghijklmnopqrstuvwxyz0123456789")
        let bodyCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        guard !kind.isEmpty, kind.allSatisfy(lowercase.contains),
              body.count >= 20, body.allSatisfy(bodyCharacters.contains) else { return nil }
        return token
    }

    /// Said of a paste that isn't one, never repeating it.
    public static let problem = "That isn't a token from claude setup-token. Copy the whole line it printed (it starts with sk-ant-) and paste it again."
}

/// A sign-in's name, as the daemon takes one: 1–60 characters, no control characters, and no double quote or backslash
/// (it goes inside the quotes of the Keychain item's label).
public enum SessionSignInName {
    public static func problem(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let control = name.unicodeScalars.contains { $0.value < 0x20 || (0x7F...0x9F).contains($0.value) }
        if trimmed.isEmpty || trimmed.count > 60 || control || name.contains("\"") || name.contains("\\") {
            return "Name the sign-in in 1–60 characters, without double quotes or backslashes"
        }
        return nil
    }
}

/// The start sheets' "Signs in as": Default's rotating login, or one of the sign-ins by name. `selection` nil is the
/// rotating login.
public struct StartSignInPicker: View {
    public let signIns: [ClaudeSessionSignIn]
    @Binding public var selection: String?

    public init(signIns: [ClaudeSessionSignIn], selection: Binding<String?>) {
        self.signIns = signIns
        self._selection = selection
    }

    public var body: some View {
        HStack(spacing: 10) {
            Text("Signs in as").font(.caption).foregroundStyle(ConchColor.textSecondary)
            Spacer(minLength: 8)
            Picker("Signs in as", selection: Binding(
                get: { SessionSignInChoice.shown(selection: selection, signIns: signIns) },
                set: { selection = $0 }
            )) {
                Text(SessionSignInChoice.rotating).tag(String?.none)
                ForEach(signIns) { signIn in
                    Text(signIn.label).tag(Optional(signIn.id))
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()
        }
        .accessibilityElement(children: .contain)
        .help("Which Claude subscription this session signs in as. Default's own login moves between your accounts; a sign-in keeps this session on one.")
    }
}
