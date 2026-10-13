import SwiftUI
import XCTest
@testable import ConchDesign

/// The logins inventory as the Mac reads it (src/login-inventory.ts): the daemon's reply decoded, grouped a block per
/// kind, and a row drawn. Every account here is invented.
///
/// `CONCH_LOGIN_RENDERS=<dir>` also writes the rows as PNGs, light and dark, to look at.
@MainActor
final class LoginInventoryTests: XCTestCase {
    private let reply = """
    {"kind":"login-inventory","checkedAt":1760443200000,"items":[
      {"id":"agent:claude:default","kind":"agent","tool":"claude","installed":true,"state":"signed-in","account":"alex@example.com","scope":"Default","configDir":"/Users/alex/.claude","checkedAt":1760443200000,"detail":"max"},
      {"id":"cli:gh:github.com:alex","kind":"cli","tool":"gh","installed":true,"state":"signed-in","account":"alex","scope":"github.com","configDir":"/Users/alex/.config/gh","checkedAt":1760443200000,"detail":"active"},
      {"id":"cli:npm","kind":"cli","tool":"npm","installed":true,"state":"signed-out","checkedAt":1760443200000},
      {"id":"cli:wrangler","kind":"cli","tool":"wrangler","installed":false,"state":"signed-out","checkedAt":1760443200000,"detail":"not installed"},
      {"id":"cli:vercel:alex@example.com","kind":"cli","tool":"vercel","installed":true,"state":"expired","account":"alex@example.com","checkedAt":1760443200000,"detail":"its login has expired; sign in again"},
      {"id":"browser-profile:default","kind":"browser-profile","tool":"Default","installed":true,"state":"unknown","scope":"default","checkedAt":1760443200000},
      {"id":"mcp:claude:default:linear:1","kind":"mcp","tool":"linear","installed":true,"state":"signed-out","scope":"user","via":"Claude Code · Default","transport":"http","checkedAt":1760443200000,"detail":"mcp.linear.example · asked Claude Code to sign in 3 h ago"},
      {"id":"plugin:claude:default:figma@market:2","kind":"plugin","tool":"figma@market","installed":true,"state":"unknown","scope":"user","via":"Claude Code · Default","checkedAt":1760443200000,"detail":"v2.0.0 · enabled"},
      {"id":"future:1","kind":"keychain-item","tool":"later","installed":true,"state":"half-signed-in","checkedAt":1760443200000}
    ]}
    """

    func testTheReplyDecodesAndANewerDaemonsKindsAndStatesDontBreakIt() throws {
        let decoded = try JSONDecoder().decode(LoginInventoryReply.self, from: Data(reply.utf8))
        XCTAssertEqual(decoded.items.count, 9)
        XCTAssertEqual(decoded.items[0], LoginRecord(id: "agent:claude:default", kind: .agent, tool: "claude", state: .signedIn,
                                                     account: "alex@example.com", scope: "Default", configDir: "/Users/alex/.claude",
                                                     checkedAt: 1_760_443_200_000, detail: "max"))
        XCTAssertEqual(decoded.items[8].kind, .other, "a kind this build doesn't know")
        XCTAssertEqual(decoded.items[8].state, .unknown, "a state this build doesn't know")
        XCTAssertNil(decoded.truncated)
    }

    func testABlockPerKindInOrderWithTheUninstalledNamedOnce() throws {
        let groups = LoginInventory.groups(try JSONDecoder().decode(LoginInventoryReply.self, from: Data(reply.utf8)).items)
        XCTAssertEqual(groups.map(\.title), ["Agents", "CLIs", "Browser profiles", "MCP servers", "Plugins"])
        let clis = try XCTUnwrap(groups.first { $0.kind == .cli })
        XCTAssertEqual(clis.items.map(\.tool), ["gh", "npm", "vercel"])
        XCTAssertEqual(clis.notInstalled, ["wrangler"])
        XCTAssertEqual(Set(groups.map(\.symbol)).count, groups.count, "a mark each")
        XCTAssertFalse(groups.contains { $0.kind == .other }, "a kind from a newer daemon has no block")
        XCTAssertTrue(LoginInventory.groups([]).isEmpty)
    }

    func testEachRowSaysWhereItIsAndItsStateInWords() throws {
        let items = try JSONDecoder().decode(LoginInventoryReply.self, from: Data(reply.utf8)).items
        XCTAssertEqual(items[6].secondaryLine, "Claude Code · Default · user · http · mcp.linear.example · asked Claude Code to sign in 3 h ago")
        XCTAssertEqual(items[2].secondaryLine, nil)
        XCTAssertEqual([LoginRecord.State.signedIn, .signedOut, .expired, .unknown].map(\.title), ["Signed in", "Signed out", "Expired", "Unknown"])
        XCTAssertEqual(LoginInventory.color(.expired).name, "attention")
        XCTAssertEqual(LoginInventory.color(.signedIn).name, "added")
        let now = Date(timeIntervalSince1970: 1_760_443_200)
        XCTAssertEqual(LoginInventory.checked(1_760_443_200_000 - 30_000, now: now), "Checked just now")
        XCTAssertEqual(LoginInventory.checked(1_760_443_200_000 - 5 * 60_000, now: now), "Checked 5 min ago")
        XCTAssertEqual(LoginInventory.checked(1_760_443_200_000 - 3 * 3_600_000, now: now), "Checked 3 h ago")
    }

    func testTheRequestsAreTheDaemonsShape() throws {
        let encode = { (request: LoginInventoryRequest) in
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: String]
        }
        XCTAssertEqual(try encode(.list), ["kind": "login-inventory", "action": "list"])
        XCTAssertEqual(try encode(.refreshAll), ["kind": "login-inventory", "action": "refresh"])
        XCTAssertEqual(try encode(.refresh("cli:gh")), ["kind": "login-inventory", "action": "refresh", "id": "cli:gh"])
    }

    /// A card of rows at the section's measure (720 less its 24-point insets), both schemes: the account and state
    /// columns line up row to row, and nothing is drawn past the card.
    func testRowsDrawInTheirColumns() throws {
        let items = LoginInventory.groups(try JSONDecoder().decode(LoginInventoryReply.self, from: Data(reply.utf8)).items).flatMap(\.items)
        for dark in [false, true] {
            let card = OnboardingCard {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { Rectangle().fill(ConchColor.hairline).frame(height: 1) }
                    LoginRow(record: item, note: item.kind == .browserProfile ? "1,204 cookies from Chrome" : nil,
                             isRefreshing: false, onRefresh: {})
                }
            }
            let content = card
                .padding(24)
                .frame(width: 720)
                .background(dark ? ConchColor.ground.dark.color : ConchColor.ground.light.color)
                .environment(\.colorScheme, dark ? .dark : .light)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.cgImage)
            XCTAssertEqual(image.width, 1440)
            XCTAssertGreaterThan(image.height, 2 * 40 * items.count, "each row at least 40 points tall, with its hairline")
            if let directory = ProcessInfo.processInfo.environment["CONCH_LOGIN_RENDERS"] {
                try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                let url = URL(fileURLWithPath: directory).appendingPathComponent("logins-\(dark ? "dark" : "light").png")
                let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
                CGImageDestinationAddImage(destination, image, nil)
                XCTAssertTrue(CGImageDestinationFinalize(destination))
            }
        }
    }
}
