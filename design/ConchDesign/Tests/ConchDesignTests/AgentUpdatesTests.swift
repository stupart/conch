import XCTest
import SwiftUI
@testable import ConchDesign

/// Settings › Providers' versions card (src/agent-updates.ts): what it decodes and says, and that it lays out on the
/// page's own column in both appearances.
private struct StandInMarks: AgentUpdateMarks {
    func mark(_ backend: String) -> Image? { Image(systemName: "circle.fill") }
}

@MainActor
final class AgentUpdatesTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private var row: AgentUpdateRow {
        AgentUpdateRow(
            backend: "claude", displayName: "Claude Code", channel: "homebrew-cask",
            source: "Homebrew cask claude-code@latest", installed: "2.1.309", newest: "2.1.319",
            cask: "claude-code@latest", checkedAt: now.timeIntervalSince1970 * 1000 - 12 * 60_000
        )
    }

    func testDecodesAFullRowAndToleratesAnOlderOne() throws {
        let json = """
        {"kind":"agent-updates","auto":true,"agents":[
          {"backend":"claude","displayName":"Claude Code","channel":"homebrew-cask","source":"Homebrew cask claude-code@latest",
           "installed":"2.1.309","newest":"2.1.319","cask":"claude-code@latest","checkedAt":1.0,"canUpdate":true,"updating":false,
           "olderSessions":{"count":2,"versions":["2.1.300"]},
           "failure":{"at":2.0,"phase":"update","message":"brew failed","output":"tail"}},
          {"backend":"codex"}
        ]}
        """
        let reply = try JSONDecoder().decode(AgentUpdatesReply.self, from: Data(json.utf8))
        XCTAssertTrue(reply.auto)
        XCTAssertEqual(reply.agents[0].olderSessions, AgentUpdateRow.OlderSessions(count: 2, versions: ["2.1.300"]))
        XCTAssertEqual(reply.agents[0].failure?.output, "tail")
        XCTAssertEqual(reply.agents[1].displayName, "codex")
        XCTAssertEqual(reply.agents[1].channel, "not-managed")
        XCTAssertFalse(reply.agents[1].canUpdate)
        XCTAssertEqual(reply.agents[1].olderSessions.count, 0)
    }

    func testRequestEncodesAsTheDaemonExpects() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AgentUpdatesRequest.updateNow("codex"))) as? [String: String]
        XCTAssertEqual(body, ["kind": "agent-updates", "action": "update-now", "backend": "codex"])
    }

    func testTheLinesItShows() {
        XCTAssertEqual(AgentUpdates.installLine(row, now: now), "Homebrew cask claude-code@latest · 2.1.319 available · Checked 12 min ago")
        XCTAssertTrue(AgentUpdates.isBehind(row))
        let current = AgentUpdateRow(backend: "codex", displayName: "Codex", source: "Homebrew cask codex", installed: "0.167.0", newest: "0.167.0", checkedAt: now.timeIntervalSince1970 * 1000)
        XCTAssertFalse(AgentUpdates.isBehind(current))
        XCTAssertEqual(AgentUpdates.installLine(current, now: now), "Homebrew cask codex · Up to date · Checked just now")
        // Numeric, not textual: 2.1.9 is older than 2.1.10.
        let numeric = AgentUpdateRow(backend: "claude", displayName: "C", installed: "2.1.9", newest: "2.1.10")
        XCTAssertTrue(AgentUpdates.isBehind(numeric))
        let unreadable = AgentUpdateRow(backend: "claude", displayName: "C", installed: "2.1.9", newest: "latest")
        XCTAssertFalse(AgentUpdates.isBehind(unreadable))
        let leftAlone = AgentUpdateRow(backend: "claude", displayName: "Claude Code", channel: "updates-itself", source: "Its own installer, which updates itself", installed: "2.1.320", canUpdate: false)
        XCTAssertEqual(AgentUpdates.installLine(leftAlone, now: now), "Its own installer, which updates itself")
    }

    func testTheLastUpdateAndAFailureAreSaidPlainly() {
        let updated = AgentUpdateRow(backend: "claude", displayName: "C", updatedAt: now.timeIntervalSince1970 * 1000 - 3 * 3_600_000, updatedFrom: "2.1.309", updatedTo: "2.1.319")
        XCTAssertEqual(AgentUpdates.lastUpdate(updated, now: now), "Updated 2.1.309 → 2.1.319, 3 h ago")
        XCTAssertNil(AgentUpdates.lastUpdate(row, now: now))
        let failure = AgentUpdateRow.Failure(at: now.timeIntervalSince1970 * 1000 - 60_000, phase: "update", message: "brew upgrade --cask codex failed (exit 1)", output: "tail")
        XCTAssertEqual(AgentUpdates.failureLine(failure, now: now), "Couldn't update 1 min ago: brew upgrade --cask codex failed (exit 1)")
        let check = AgentUpdateRow.Failure(at: now.timeIntervalSince1970 * 1000, phase: "check", message: "couldn't reach formulae.brew.sh", output: nil)
        XCTAssertEqual(AgentUpdates.failureLine(check, now: now), "Couldn't check for a new version just now: couldn't reach formulae.brew.sh")
    }

    /// The hard rule, in the words: it says sessions move when restarted, and never that conch will do it.
    func testOldSessionsAreOnlyEverToldAbout() {
        var withOlder = row
        withOlder = AgentUpdateRow(backend: withOlder.backend, displayName: withOlder.displayName, installed: "2.1.319", olderSessions: .init(count: 3, versions: ["2.1.309"]))
        let line = AgentUpdates.olderSessionsLine(withOlder)
        XCTAssertEqual(line, "3 running sessions are still on 2.1.309. They move to 2.1.319 when you restart them; conch won't.")
        XCTAssertEqual(AgentUpdates.olderSessionsLine(AgentUpdateRow(backend: "c", displayName: "C", installed: "1.0.0", olderSessions: .init(count: 1, versions: ["0.9.0", "0.8.0"]))),
                       "1 running session is still on older versions. They move to 1.0.0 when you restart them; conch won't.")
        XCTAssertNil(AgentUpdates.olderSessionsLine(row))
    }

    /// Lays out inside the page's column in both appearances: every row starts on the same edge and nothing is drawn past
    /// the card. `CONCH_AGENT_UPDATES_RENDERS` keeps the images, for a person or a design check to read.
    func testCardDrawsInItsColumnInBothAppearances() throws {
        let reply = AgentUpdatesReply(kind: "agent-updates", auto: true, agents: [
            AgentUpdateRow(backend: "claude", displayName: "Claude Code", source: "Homebrew cask claude-code@latest", installed: "2.1.319", newest: "2.1.321",
                           cask: "claude-code@latest", checkedAt: now.timeIntervalSince1970 * 1000 - 720_000,
                           updatedAt: now.timeIntervalSince1970 * 1000 - 3 * 3_600_000, updatedFrom: "2.1.309", updatedTo: "2.1.319",
                           failure: .init(at: now.timeIntervalSince1970 * 1000 - 60_000, phase: "update", message: "brew upgrade --cask claude-code@latest failed (exit 1)", output: "tail"),
                           olderSessions: .init(count: 3, versions: ["2.1.309"])),
            AgentUpdateRow(backend: "codex", displayName: "Codex", source: "Homebrew cask codex", installed: "0.167.0", newest: "0.167.0", cask: "codex",
                           checkedAt: now.timeIntervalSince1970 * 1000, updating: true),
            AgentUpdateRow(backend: "fable", displayName: "A native CLI", channel: "updates-itself", source: "Its own installer, which updates itself", installed: "1.2.3", canUpdate: false),
        ])
        for dark in [false, true] {
            let content = AgentUpdatesCard(reply: reply, now: now, marks: StandInMarks(), onUpdate: { _ in }, onSetAuto: { _ in })
                .padding(24)
                .frame(width: SettingsLayout.column)
                .background(dark ? ConchColor.ground.dark.color : ConchColor.ground.light.color)
                .environment(\.colorScheme, dark ? .dark : .light)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.cgImage)
            XCTAssertEqual(image.width, Int(SettingsLayout.column) * 2)
            XCTAssertGreaterThan(image.height, 2 * 40 * reply.agents.count, "each row at least 40 points tall")
            if let directory = ProcessInfo.processInfo.environment["CONCH_AGENT_UPDATES_RENDERS"] {
                try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                let url = URL(fileURLWithPath: directory).appendingPathComponent("agent-updates-\(dark ? "dark" : "light").png")
                let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
                CGImageDestinationAddImage(destination, image, nil)
                XCTAssertTrue(CGImageDestinationFinalize(destination))
            }
        }
    }
}
