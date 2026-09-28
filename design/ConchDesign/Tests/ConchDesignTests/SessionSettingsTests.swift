import XCTest
@testable import ConchDesign

/// A session's model and effort as both apps read the daemon's `rows[].settings` and `sessionSettings`
/// (src/session-settings.ts), and the words every surface shows for them.
final class SessionSettingsTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private let catalogJSON = """
    {
      "claude": {
        "settings": [{"key": "model", "label": "Model", "readFrom": "the transcript"}],
        "models": [{"id": "default", "label": "Default"}, {"id": "opus", "label": "Opus"}, {"id": "haiku", "label": "Haiku", "efforts": []}, {"broken": true}],
        "efforts": ["low", "medium", "high", "xhigh", "max"],
        "defaults": {"source": "/Users/me/.claude/settings.json", "perModelEffort": {"claude-opus-5-5": "xhigh", "claude-fable-5-1": "high"}}
      },
      "codex": {
        "models": [{"id": "gpt-6-astra", "label": "GPT-6-Astra", "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"], "defaultEffort": "medium"},
                   {"id": "gpt-5.5", "label": "GPT-5.5", "efforts": ["low", "medium", "high", "xhigh"]}],
        "efforts": ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"],
        "defaults": {"model": "gpt-6-astra", "effort": "xhigh", "source": "/Users/me/.codex/config.toml"},
        "somethingNewer": 1
      }
    }
    """

    func testDecodesTheCatalogLeniently() throws {
        let catalog = try decode(SessionSettingsCatalog.self, catalogJSON)
        XCTAssertEqual(catalog.claude?.models.map(\.id), ["default", "opus", "haiku"], "a model this build can't read is dropped, not fatal")
        XCTAssertEqual(catalog.claude?.models.last?.efforts, [])
        XCTAssertEqual(catalog.codex?.defaults.model, "gpt-6-astra")
        XCTAssertEqual(catalog.agent("codex")?.models.first?.label, "GPT-6-Astra")
        XCTAssertEqual(catalog.agent(nil), catalog.claude, "absent backend is Claude")
        XCTAssertEqual(try decode(SessionSettingsCatalog.self, "{}"), SessionSettingsCatalog())
    }

    func testDecodesARowsSettingsAndAChangeInFlight() throws {
        let state = try decode(SessionSettingsState.self, """
        {"model": "claude-opus-5-5", "modelLabel": "Opus 5.5", "modelChoice": "opus", "effort": "xhigh", "at": 5,
         "change": {"state": "applying", "effort": "max", "at": 7, "startedAt": 7}}
        """)
        XCTAssertEqual(state.modelLabel, "Opus 5.5")
        XCTAssertEqual(state.change?.state, "applying")
        XCTAssertEqual(state.change?.effort, "max")
    }

    func testTheTitleNeverGuesses() {
        XCTAssertEqual(SessionSettingsPresentation.title(nil), "default")
        XCTAssertEqual(SessionSettingsPresentation.title(SessionSettingsState()), "default")
        XCTAssertEqual(SessionSettingsPresentation.title(SessionSettingsState(model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: "xhigh")), "Opus 5.5 · xhigh")
        XCTAssertEqual(SessionSettingsPresentation.title(SessionSettingsState(model: "gpt-9")), "gpt-9")
        XCTAssertEqual(SessionSettingsPresentation.title(SessionSettingsState(effort: "high")), "default · high")
    }

    func testAChangeSaysWhatItIsDoingOrWhyItDidNot() {
        let applying = SessionSettingsState(change: .init(state: "applying", model: "gpt-5.5", effort: "high"))
        XCTAssertEqual(SessionSettingsPresentation.applying(applying), "Switching to gpt-5.5 · high…")
        XCTAssertNil(SessionSettingsPresentation.failure(applying))
        let failed = SessionSettingsState(change: .init(state: "failed", message: "its prompt holds unsent words"))
        XCTAssertEqual(SessionSettingsPresentation.failure(failed), "Not changed: its prompt holds unsent words")
        XCTAssertNil(SessionSettingsPresentation.applying(failed))
        XCTAssertNil(SessionSettingsPresentation.failure(SessionSettingsState(change: .init(state: "applied"))))
    }

    func testTheEffortsOfferedAreTheSessionsModels() throws {
        let catalog = try decode(SessionSettingsCatalog.self, catalogJSON)
        let codex = catalog.codex
        XCTAssertEqual(SessionSettingsPresentation.efforts(for: SessionSettingsState(modelChoice: "gpt-5.5"), in: codex), ["low", "medium", "high", "xhigh"])
        XCTAssertEqual(SessionSettingsPresentation.efforts(for: SessionSettingsState(model: "gpt-9"), in: codex), codex?.efforts, "unknown model: the agent's list")
        XCTAssertEqual(SessionSettingsPresentation.efforts(for: SessionSettingsState(modelChoice: "haiku"), in: catalog.claude), [], "Haiku takes none")
        XCTAssertEqual(SessionSettingsPresentation.currentModel(SessionSettingsState(modelChoice: "OPUS"), in: catalog.claude)?.id, "opus")
        XCTAssertNil(SessionSettingsPresentation.currentModel(SessionSettingsState(), in: catalog.claude))
    }

    func testSettingsSaysEachAgentsOwnDefault() throws {
        let catalog = try decode(SessionSettingsCatalog.self, catalogJSON)
        XCTAssertEqual(SessionSettingsPresentation.defaultsLine(catalog.codex!.defaults), "Model: gpt-6-astra · Effort: xhigh")
        XCTAssertEqual(SessionSettingsPresentation.defaultsLine(catalog.claude!.defaults), "Model: the agent's own default · Effort: set per model")
        XCTAssertEqual(SessionSettingsPresentation.perModelEffortLines(catalog.claude!.defaults), ["claude-fable-5-1 high", "claude-opus-5-5 xhigh"])
        XCTAssertEqual(
            SessionSettingsPresentation.defaultsLine(.init(profile: "work")),
            "Model: the agent's own default · Effort: the agent's own default · Profile: work"
        )
    }
}
