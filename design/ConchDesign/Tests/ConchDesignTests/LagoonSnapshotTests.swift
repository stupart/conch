import XCTest
@testable import ConchDesign

/// The snapshot the lagoon is handed (LagoonSnapshot.swift): exactly the brand repo's whitelist (experiments/bridge/
/// sanitize.mjs), cut where it cuts, and never a field from its NEVER list. test/lagoon-page.test.ts runs sanitize.mjs
/// itself on a fixture `PublishedState` and compares, when that repo is on the Mac.
final class LagoonSnapshotTests: XCTestCase {
    /// sanitize.mjs `NEVER`, as of 2026-10-04: every key that must never reach the world.
    static let never: Set<String> = [
        "transcriptPath", "accountLabel", "claudeAccountId", "codexAccountId", "settings", "voice", "execution", "ownerDeviceId",
        "link", "snapshot", "access", "roots", "focus", "marks", "preview", "deliveries", "audioControl", "audioOutbox", "phone",
        "showing", "sessionSettings", "naturalVoices", "speechEngine", "conversation", "previewRequests", "practice", "artifact",
        "linkRefused",
    ]

    /// Every key the lagoon may be sent, at any depth (spec §4).
    static let allowed: Set<String> = [
        "v", "ts", "mode", "paused", "holding", "live", "state", "rows", "conversations", "dismissed",
        "id", "label", "status", "needsResponse", "detail", "snippet", "cwd", "workDirs", "backend", "parentSessionId",
        "startedBySessionId", "context", "usedTokens", "limitTokens", "pauseExempt", "muted", "active", "waitingOnAgents",
        "usageLimit", "at", "activity", "text", "kind", "approval", "name", "summary", "answerable", "reviews", "viewedAt",
        "version", "scene", "target", "inspect", "open", "sessionId", "items",
        // sanitize.mjs v4.10: a session's model and effort labels, and an answer's step count and time.
        "model", "effort", "steps", "took",
        // 2026-10-05, agreed with the brand repo: a review's approval, and the sea glass approvals have earned.
        "approvedAt", "seaGlass",
    ]

    private let home = "/Users/someone"

    private func rich() -> LagoonSnapshot.Source {
        LagoonSnapshot.Source(
            ts: 1_791_039_810_478,
            paused: true,
            holding: 2,
            liveState: "speaking",
            rows: [
                .init(
                    id: "s1", label: "Lagoon page", status: "needs", needsResponse: true, detail: "Allow Bash?", snippet: "Running tests",
                    cwd: "/Users/someone/Projects/Conch", workDirs: ["/Users/someone/Projects/Conch", "/tmp/x", "/Users/someone", "/fourth"],
                    backend: nil, providerId: "codex", parentSessionId: nil, startedBySessionId: "s0", usedTokens: 120_000, limitTokens: 200_000,
                    paused: true, pauseExempt: true, live: "speaking", active: true, waitingOnAgents: true, usageLimit: "You've hit your limit",
                    at: 1_791_039_800_000, activity: .init(text: "Running the test suite", kind: "step", at: 1_791_039_805_000),
                    approval: .init(id: "a1", name: "Bash", summary: "rm -rf build", answerable: false),
                    reviews: [
                        .init(id: "r1", artifact: "art", summary: "The page", kind: "page", at: 1, viewedAt: 2, approvedAt: 2.5, version: 3,
                              hasScene: true, targetKind: "page", inspect: "the header", link: "output/page.html"),
                        .init(id: nil, artifact: nil, summary: "A site", kind: "url", at: 4, link: "https://example.com/x"),
                        .init(summary: "no link"),
                    ]
                ),
                .init(id: "s2", status: "review", backend: "claude", providerId: "codex", live: nil),
            ],
            conversations: [
                "s1": [
                    .init(id: "u1", kind: "user", text: "hi", at: 1),
                    .init(id: "t1", kind: "tool", text: "ls", at: 2),
                    .init(id: "a1", kind: "assistant", text: "first", at: 3),
                    .init(id: "th", kind: "thinking", text: "hmm", at: 4),
                    .init(id: "t2", kind: "tool", text: "cat", at: 5),
                    .init(id: "m1", kind: "material", text: "a file", at: 6),
                    .init(id: "t3", kind: "tool", text: "grep", at: 7),
                    .init(id: "a2", kind: "assistant", text: "second", at: 6.5),
                ],
                "gone": [.init(id: "x", kind: "assistant", text: "no row", at: 1)],
            ],
            dismissed: ["d1", "d2", "d1"],
            seaGlass: 4
        )
    }

    private func json(_ snapshot: LagoonSnapshot) throws -> [String: Any] {
        try XCTUnwrap(try snapshot.jsonObject() as? [String: Any])
    }

    /// Every key at every depth, except the keys of `conversations` (session ids).
    private func keys(_ value: Any, under parent: String? = nil) -> Set<String> {
        if let object = value as? [String: Any] {
            var found = Set<String>()
            for (key, child) in object {
                if parent != "conversations" { found.insert(key) }
                found.formUnion(keys(child, under: key))
            }
            return found
        }
        if let list = value as? [Any] { return list.reduce(into: Set<String>()) { $0.formUnion(keys($1)) } }
        return []
    }

    func testOnlyTheWhitelistIsEncodedAndNothingFromNeverIs() throws {
        let object = try json(LagoonSnapshot(rich(), home: home))
        let found = keys(object)
        XCTAssertTrue(found.isSubset(of: Self.allowed), "not on the whitelist: \(found.subtracting(Self.allowed).sorted())")
        // `kind` and `text` are allowed only where the whitelist puts them; none of NEVER anywhere.
        XCTAssertTrue(found.isDisjoint(with: Self.never), "sent: \(found.intersection(Self.never).sorted())")
        let data = try JSONEncoder().encode(LagoonSnapshot(rich(), home: home))
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(text.contains("output/page.html"), "a raw link reached the page")
        XCTAssertFalse(text.contains("You've hit your limit"), "the provider's words reached the page")
    }

    func testTheRowAsTheLagoonReadsIt() throws {
        let object = try json(LagoonSnapshot(rich(), home: home))
        XCTAssertEqual(object["v"] as? Int, 1)
        XCTAssertEqual(object["ts"] as? Double, 1_791_039_810_478)
        let mode = try XCTUnwrap(object["mode"] as? [String: Any])
        XCTAssertEqual(mode["paused"] as? Bool, true)
        XCTAssertEqual(mode["holding"] as? Int, 2)
        XCTAssertEqual(object["live"] as? [String: String], ["state": "speaking"])
        let rows = try XCTUnwrap(object["rows"] as? [[String: Any]])
        let row = rows[0]
        XCTAssertEqual(row["status"] as? String, "needs")
        XCTAssertEqual(row["cwd"] as? String, "~/Projects/Conch")
        XCTAssertEqual(row["workDirs"] as? [String], ["~/Projects/Conch", "/tmp/x", "~"])
        XCTAssertEqual(row["backend"] as? String, "codex")
        XCTAssertEqual(row["context"] as? [String: Int], ["usedTokens": 120_000, "limitTokens": 200_000])
        XCTAssertEqual(row["pauseExempt"] as? Bool, true)
        XCTAssertEqual(row["muted"] as? Bool, false)
        XCTAssertEqual(row["usageLimit"] as? Bool, true)
        XCTAssertEqual(row["waitingOnAgents"] as? Bool, true)
        XCTAssertEqual(row["startedBySessionId"] as? String, "s0")
        let activity = try XCTUnwrap(row["activity"] as? [String: Any])
        XCTAssertEqual(activity["text"] as? String, "Running the test suite")
        XCTAssertEqual(activity["kind"] as? String, "step")
        XCTAssertEqual(activity["at"] as? Double, 1_791_039_805_000)
        let approval = try XCTUnwrap(row["approval"] as? [String: Any])
        XCTAssertEqual(approval["id"] as? String, "a1")
        XCTAssertEqual(approval["name"] as? String, "Bash")
        XCTAssertEqual(approval["summary"] as? String, "rm -rf build")
        XCTAssertEqual(approval["answerable"] as? Bool, false)
        // A row with less: status not one the lagoon knows is null, live is null, the agent from the row's own backend.
        let quiet = rows[1]
        XCTAssertTrue(quiet["status"] is NSNull)
        XCTAssertTrue(quiet["live"] is NSNull)
        XCTAssertEqual(quiet["backend"] as? String, "claude")
        XCTAssertNil(quiet["pauseExempt"])
        XCTAssertNil(quiet["context"])
        XCTAssertNil(quiet["usageLimit"])
        XCTAssertEqual((quiet["reviews"] as? [Any])?.count, 0)
    }

    func testReviewsCarryOpenNeverTheirLink() throws {
        let rows = try XCTUnwrap(try json(LagoonSnapshot(rich(), home: home))["rows"] as? [[String: Any]])
        let reviews = try XCTUnwrap(rows[0]["reviews"] as? [[String: Any]])
        XCTAssertEqual(reviews.count, 3)
        XCTAssertEqual(reviews[0]["id"] as? String, "r1")
        XCTAssertEqual(reviews[0]["open"] as? String, "conch-lagoon://lagoon/review/s1/r1")
        let scene = try XCTUnwrap(reviews[0]["scene"] as? [String: Any])
        XCTAssertEqual(scene["target"] as? [String: String], ["kind": "page"])
        XCTAssertEqual(scene["inspect"] as? String, "the header")
        XCTAssertEqual(reviews[0]["version"] as? Int, 3)
        // No id and no artifact: keyed by its place. A web link is handed over as it is.
        XCTAssertEqual(reviews[1]["id"] as? String, "1")
        XCTAssertEqual(reviews[1]["open"] as? String, "https://example.com/x")
        XCTAssertNil(reviews[1]["scene"])
        XCTAssertNil(reviews[2]["open"])
    }

    func testTheRecentMessagesAndTwoStepsOfEachConversation() throws {
        let object = try json(LagoonSnapshot(rich(), home: home))
        let conversations = try XCTUnwrap(object["conversations"] as? [String: [String: Any]])
        XCTAssertEqual(Set(conversations.keys), ["s1"], "only sessions that are rows")
        let items = try XCTUnwrap(conversations["s1"]?["items"] as? [[String: Any]])
        // Both sides' messages (sanitize.mjs v4.10) and the last two tools, in time order; never thinking or material.
        XCTAssertEqual(items.map { $0["id"] as? String }, ["u1", "a1", "t2", "a2", "t3"])
        XCTAssertEqual(conversations["s1"]?["sessionId"] as? String, "s1")
        // An answer carries its turn's step count and time, never the steps.
        let answer = try XCTUnwrap(items.first { $0["id"] as? String == "a2" })
        XCTAssertNotNil(answer["steps"])
    }

    func testOnlyTheLastTwelveMessages() {
        let items: [LagoonSnapshot.Source.Item] = (0..<20).map { .init(id: "m\($0)", kind: $0 % 2 == 0 ? "user" : "assistant", text: "x", at: Double($0)) }
        let snapshot = LagoonSnapshot(.init(ts: 1, paused: false, holding: 0, liveState: nil, rows: [.init(id: "s")],
                                            conversations: ["s": items], dismissed: []), home: home)
        XCTAssertEqual(snapshot.conversations["s"]?.items.map(\.id), (8..<20).map { "m\($0)" })
    }

    func testCutsAsSanitizeCuts() {
        XCTAssertEqual(LagoonSnapshot.cut("abc", 3), "abc")
        XCTAssertEqual(LagoonSnapshot.cut("abcd", 3), "ab…")
        XCTAssertNil(LagoonSnapshot.cut(nil, 3))
        // Counted in UTF-16, as JavaScript counts: an emoji is two.
        XCTAssertEqual(LagoonSnapshot.cut("a😀bc", 4), "a😀…")
        XCTAssertEqual(LagoonSnapshot.cut("ab😀cd", 4), "ab…", "never half a surrogate pair")
        let long = String(repeating: "x", count: 500)
        let snapshot = LagoonSnapshot(.init(ts: 1, paused: false, holding: 0, liveState: String(repeating: "s", count: 30),
                                            rows: [.init(id: "s", label: long, detail: long, snippet: long)],
                                            conversations: ["s": [.init(id: "t", kind: "tool", text: long, at: 1),
                                                                  .init(id: "a", kind: "assistant", text: long, at: 2)]],
                                            dismissed: []), home: home)
        XCTAssertEqual(snapshot.rows[0].label?.utf16.count, 120)
        XCTAssertEqual(snapshot.rows[0].detail?.utf16.count, 200)
        XCTAssertEqual(snapshot.rows[0].snippet?.utf16.count, 160)
        XCTAssertEqual(snapshot.conversations["s"]?.items.map { $0.text?.utf16.count }, [120, 500], "a message is cut at 600")
        XCTAssertEqual(snapshot.live.state.utf16.count, 20)
    }

    func testTheAgentIsResolvedAndHomeIsATilde() {
        func backend(_ own: String?, _ provider: String?) -> String {
            LagoonSnapshot(.init(ts: 1, paused: false, holding: 0, liveState: nil,
                                 rows: [.init(id: "s", backend: own, providerId: provider)], conversations: [:], dismissed: []),
                           home: home).rows[0].backend
        }
        XCTAssertEqual(backend(nil, "codex"), "codex")
        XCTAssertEqual(backend("codex", nil), "codex")
        XCTAssertEqual(backend("conch", "codex"), "codex", "conch's own practice session reads its provider")
        XCTAssertEqual(backend("claude", "codex"), "claude")
        XCTAssertEqual(backend(nil, nil), "claude", "absent means Claude")
        let snapshot = LagoonSnapshot(.init(ts: nil, paused: false, holding: 0, liveState: "", rows: [
            .init(id: "s", cwd: "/Users/someoneelse/x"),
        ], conversations: [:], dismissed: []), home: home)
        XCTAssertEqual(snapshot.rows[0].cwd, "/Users/someoneelse/x", "a prefix that isn't a folder isn't home")
        XCTAssertEqual(snapshot.live.state, "idle")
        XCTAssertNil(snapshot.ts)
    }

    /// The two fields agreed with the brand repo on 2026-10-05: `approvedAt` on a review only when it was approved, and
    /// `seaGlass` at the top always, 0 from a daemon that sends none.
    func testApprovedAtAndSeaGlassAsAgreed() throws {
        let object = try json(LagoonSnapshot(rich(), home: home))
        XCTAssertEqual(object["seaGlass"] as? Int, 4)
        let reviews = try XCTUnwrap((object["rows"] as? [[String: Any]])?.first?["reviews"] as? [[String: Any]])
        XCTAssertEqual(reviews[0]["approvedAt"] as? Double, 2.5)
        XCTAssertNil(reviews[1]["approvedAt"], "absent, never null, when it wasn't approved")
        var older = rich()
        older.seaGlass = nil
        older.rows[0].reviews[0].approvedAt = .infinity
        let fromOlder = try json(LagoonSnapshot(older, home: home))
        XCTAssertEqual(fromOlder["seaGlass"] as? Int, 0, "always sent")
        var negative = rich()
        negative.seaGlass = -2
        XCTAssertEqual(LagoonSnapshot(negative, home: home).seaGlass, 0, "never below none, as sanitize.mjs reads it")
        XCTAssertNil(((fromOlder["rows"] as? [[String: Any]])?.first?["reviews"] as? [[String: Any]])?.first?["approvedAt"],
                     "a time that isn't finite is none, as sanitize.mjs's num() reads it")
    }

    func testDismissedOnceEach() {
        XCTAssertEqual(LagoonSnapshot(rich(), home: home).dismissed, ["d1", "d2"])
    }

    func testHeldAndItsKeys() {
        XCTAssertEqual(LagoonSnapshot.held(reviews: ["a", "b"], review: "c"), ["a", "b"])
        XCTAssertEqual(LagoonSnapshot.held(reviews: [], review: "c"), ["c"])
        XCTAssertEqual(LagoonSnapshot.held(reviews: nil, review: Optional<String>.none), [])
        XCTAssertEqual(LagoonSnapshot.reviewKey(id: "r", artifact: "a", index: 0), "r")
        XCTAssertEqual(LagoonSnapshot.reviewKey(id: "", artifact: "a", index: 0), "a")
        XCTAssertEqual(LagoonSnapshot.reviewKey(id: nil, artifact: nil, index: 2), "2")
        XCTAssertEqual(LagoonSnapshot.openURL(sessionId: "s 1", reviewKey: "r", link: "x.md"), "conch-lagoon://lagoon/review/s%201/r")
        XCTAssertEqual(LagoonSnapshot.openURL(sessionId: "s", reviewKey: "r", link: "HTTPS://example.com"), "HTTPS://example.com")
        XCTAssertNil(LagoonSnapshot.openURL(sessionId: "s", reviewKey: "r", link: ""))
    }
}
