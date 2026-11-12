import ConchDesign
import SwiftUI

/// Messages between agent sessions (`PeerMessageRow`), at both ends, between Tyler's own words and a reply so the rows
/// can be judged against his bubble beside them: what the session that was sent one shows, and what the session that
/// sent it shows, every delivery state. Names and words are made up.
func renderPeerMessages() throws {
    let base = Date(timeIntervalSince1970: 1_794_740_400)
    func at(_ minutes: Double) -> Date { base.addingTimeInterval(minutes * 60) }
    let yours = { (words: String) in
        HStack {
            Spacer(minLength: 48)
            Text(words)
                .font(ConchType.readingBody)
                .foregroundStyle(ConchColor.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(ConchColor.fill, in: RoundedRectangle(cornerRadius: ConchRadius.large))
        }
    }
    let reply = { (words: String) in
        MarkdownView(text: words).foregroundStyle(ConchColor.textPrimary).frame(maxWidth: .infinity, alignment: .leading)
    }
    let conversation = { (content: AnyView) in
        content
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .frame(width: 560)
            .background(ConchColor.surface, in: RoundedRectangle(cornerRadius: ConchRadius.large))
    }

    try render("w3-peer-received", width: 680) {
        Heading(title: "From another session", note: "What a session that was sent a message shows: who it is from (its label, a click opens it), the words alone, the time. Never in Tyler's bubble.")
        conversation(AnyView(VStack(alignment: .leading, spacing: 22) {
            yours("Check the build, please.")
            reply("The build is green.")
            PeerMessageRow(
                message: ConchPeerMessage(direction: .received, name: "harbor", session: "s-harbor", label: "harbor", pid: 4242, msgId: "m-1"),
                body: "Is port 5173 free on your side? I want it for the docs preview.",
                at: at(3), open: {}
            )
            reply("It's free; I'm on 5174. Told harbor so.")
            PeerMessageRow(
                message: ConchPeerMessage(direction: .received, name: "lantern", viaConch: true, session: "s-lantern", label: "Lantern (Codex)", msgId: "5e0f3a2b9c71", replyTo: "000000000001"),
                body: "**Reviewed.** Two nits:\n\n- rename `parseLine` to `readLine`\n- drop the unused `limit` argument",
                at: at(9), open: {}
            )
            PeerMessageRow(
                message: ConchPeerMessage(direction: .received, name: "general-purpose", agentId: "a0123456789abcdef"),
                body: "Done: the flaky test was a timing race in the indexer.",
                at: at(14)
            )
        }))
    }

    try render("w3-peer-sent", width: 680) {
        Heading(title: "Sent to another session", note: "What the session that sent it shows: who it went to, the words, and how far it got, from the result and any later notice.")
        conversation(AnyView(VStack(alignment: .leading, spacing: 22) {
            yours("Ask harbor whether the port is free, and tell lantern the review is in.")
            PeerMessageRow(
                message: ConchPeerMessage(direction: .sent, name: "harbor", session: "s-harbor", label: "harbor", summary: "Ask about the port", delivery: .unread),
                body: "Is port 5173 free on your side?", at: at(2), open: {}
            )
            PeerMessageRow(
                message: ConchPeerMessage(direction: .sent, name: "lantern", viaConch: true, session: "s-lantern", label: "Lantern (Codex)", msgId: "1a2b3c4d5e6f", delivery: .sent),
                body: "Your review is in: two nits.", at: at(3), open: {}
            )
            PeerMessageRow(
                message: ConchPeerMessage(direction: .sent, name: "a0123456789abcdef", label: "Flaky test hunt", agentId: "a0123456789abcdef", delivery: .queued),
                body: "Also check the Codex side.", at: at(4), open: {}
            )
            PeerMessageRow(
                message: ConchPeerMessage(direction: .sent, name: "uds:/tmp/cc-socks/5151.sock", delivery: .held),
                body: "Please pause the migration.", at: at(5)
            )
            PeerMessageRow(
                message: ConchPeerMessage(direction: .sent, name: "tidepool", delivery: .failed, deliveryNote: "no agent named 'tidepool' is reachable."),
                body: "Are you there?", at: at(6)
            )
            reply("Asked harbor (unread so far) and told lantern. tidepool isn't running.")
        }))
    }
}
