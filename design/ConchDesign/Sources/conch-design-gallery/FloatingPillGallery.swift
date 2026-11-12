import ConchDesign
import SwiftUI

/// The floating pill (2026-11-11), every state, collapsed and as hovering opens it, light and dark. Names are made up.
func renderFloatingPill() throws {
    typealias S = FloatingPill.Session
    let working = [S(id: "w1", label: "site", working: true), S(id: "w2", label: "api", working: true)]
    let states: [(String, FloatingPill.Input)] = [
        ("Nothing happening", .init()),
        ("Manual", .init(sessions: [S(id: "a", label: "conch-site")], voiceLabel: "conch-site", manual: true)),
        ("Working", .init(sessions: working + [S(id: "w3", label: "notes", working: true)])),
        ("Speaking", .init(sessions: [S(id: "a", label: "conch-site")] + working, voice: .speaking, voiceSession: "a",
                           voiceLabel: "conch-site", caption: "I pushed version three of the hero and the build is green", exchangeActive: true)),
        ("Listening, with a need behind it", .init(sessions: [S(id: "a", label: "conch-site"), S(id: "b", label: "blueprint-api", need: .permission, detail: "Bash")],
                                                   voice: .listening, voiceSession: "a", voiceLabel: "conch-site", exchangeActive: true)),
        ("A permission, and more", .init(sessions: [S(id: "b", label: "blueprint-api", need: .permission, detail: "Bash", at: 1),
                                                    S(id: "c", label: "notes", need: .ready, at: 2)] + working, manual: true)),
        ("Ready for you", .init(sessions: [S(id: "c", label: "landing-page", need: .ready, detail: "Hero, version 3")])),
        ("The voice on another device", .init(sessions: [S(id: "a", label: "conch-site")], voiceLabel: "conch-site", audioElsewhere: true)),
    ]
    try render("floating-pill", width: 760) {
        Heading(title: "Floating pill", note: "One pill over every app. Collapsed, then as hovering opens it.")
        ForEach(states.indices, id: \.self) { index in
            let (caption, input) = states[index]
            VStack(alignment: .leading, spacing: 10) {
                Caption(caption)
                HStack(alignment: .center, spacing: 24) {
                    FloatingPillView(face: FloatingPill.face(input))
                    FloatingPillView(face: FloatingPill.face(input), expanded: true)
                }
            }
        }
    }
}
