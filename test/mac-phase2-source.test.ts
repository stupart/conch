import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "mac-app", "conch-mac");
const app = (name: string) => readFileSync(join(root, name), "utf8");

describe("Mac Phase 2 session lifecycle", () => {
  const socket = app("ConchSocketClient.swift");
  const content = app("ContentView.swift");
  const dashboard = app("DashboardView.swift");
  const store = app("StateStore.swift");

  test("start supports both agents, fresh and resumed ids, and a working folder", () => {
    expect(socket).toContain('let kind = "session-start"');
    expect(socket).toContain("let backend: ConchAgentBackend");
    expect(socket).toContain("let resumeSessionId: String?");
    expect(socket).toContain("let cwd: String?");
    expect(socket).toContain('case "session-started"');
    expect(socket).toContain("let resumed: Bool");
    expect(store).toContain("started.resumed == (resumed != nil)");

    expect(content).toContain("ForEach(ConchAgentBackend.allCases)");
    expect(content).toContain('case new = "New"');
    expect(content).toContain('case resume = "Resume"');
    expect(content).toContain('TextField("Working folder", text: $cwd)');

    // Resuming is a PICKER, not a typed id. The id field was the whole reason
    // finding a session meant leaving conch for Codex, so its absence is the
    // feature and worth pinning.
    expect(content).not.toContain('TextField("Session ID"');
    expect(content).toContain("ResumePickerView(");
    expect(content).toContain("resumeSessionId: mode == .resume ? resumeSelection?.sessionId : nil");

    // A resumed session brings its own agent and folder; asking again offers a
    // wrong answer. Both must come from the picked row.
    expect(content).toContain("backend: effectiveBackend");
    expect(content).toContain("cwd: effectiveCwd");
  });

  test("close is isolated in an overflow menu and requires destructive confirmation", () => {
    expect(socket).toContain('let kind = "session-close"');
    expect(socket).toContain('case "session-closed"');
    expect(store).toContain("ConchSessionCloseRequest(sessionId: row.id)");
    expect(store).toContain("private static let sessionLifecycleTimeout: TimeInterval = 12");
    expect(store).toContain("timeout: Self.sessionLifecycleTimeout");
    expect(dashboard).toMatch(/Menu \{[\s\S]*Button\("Close session…", role: \.destructive\)/);
    expect(dashboard).toMatch(/\.alert\([\s\S]*Button\("Cancel", role: \.cancel\)[\s\S]*Button\("Close Session", role: \.destructive\)/);
    expect(dashboard).toContain("store.closeSession(row)");
    const closePath = store.slice(
      store.indexOf("func closeSession"),
      store.indexOf("func reportAppError"),
    );
    expect(closePath).not.toMatch(/\.interrupt|kill\(|terminate\(/);
  });
});

describe("Mac Phase 2 session signals", () => {
  const models = app("Models.swift");
  const dashboard = app("DashboardView.swift");

  test("backend and context decode on each row and survive optimistic label rebuilding", () => {
    expect(models).toContain("let backend: String?");
    expect(models).toContain("let context: SessionContext?");
    expect(models).toMatch(/backend = try\? container\.decodeIfPresent\(String\.self, forKey: \.backend\)/);
    expect(models).toMatch(/context = try\? container\.decodeIfPresent\(SessionContext\.self, forKey: \.context\)/);
    expect(models).toMatch(/replacingLabel[\s\S]*backend: backend,[\s\S]*context: context/);
    expect(models).toMatch(/Double\(usedTokens\) \/ Double\(limitTokens\)/);
  });

  // Agent identity belongs everywhere a session is named; context pressure
  // belongs only where you have committed to looking at one.
  test("both surfaces identify the agent", () => {
    expect(dashboard.match(/AgentBadge\(backend: row\.backend\)/g)?.length).toBeGreaterThanOrEqual(2);
    // Claude sessions predate the backend field, so absence must read as
    // Claude rather than leaving half the fleet unmarked.
    expect(dashboard).toMatch(/case nil, "", "claude": return "Claude"/);
  });

  // Rewritten from "proportional context everywhere". Tyler: the bar "adds
  // visual clutter and a lot of importance to a not super important piece of
  // data". A capsule beside every session name gave context pressure the same
  // weight as the session itself, on the surface you scan constantly.
  test("context is a number, in the conversation only", () => {
    expect(dashboard).toContain("SessionContextMeter(context: context)");
    expect(dashboard).not.toContain("compact: true");
    // No bar: nothing scales a width by the fraction any more.
    expect(dashboard).not.toContain("proxy.size.width * context.fraction");
    // Colour still carries the warning, which is the part worth interrupting for.
    expect(dashboard).toContain("context.fraction >= 0.85");
    expect(dashboard).toContain("context.fraction >= 0.97");
  });
});

describe("Mac Phase 2 questions and error reporting", () => {
  const models = app("Models.swift");
  const conversation = app("ConversationStackView.swift");
  const dashboard = app("DashboardView.swift");
  const socket = app("ConchSocketClient.swift");
  const macApp = app("ConchMacApp.swift");

  test("structured questions submit one choice immediately or an explicit ordered set", () => {
    expect(models).toContain("struct AgentQuestion: Decodable");
    expect(models).toContain("let question: AgentQuestion?");
    expect(conversation).toContain("let onAnswer: (String) -> Void");
    expect(conversation).toContain('answerable: item.tool?.status == "running"');
    expect(conversation).toContain("@State private var multiSelections: [String: Set<String>] = [:]");
    expect(conversation).toContain("toggleSelection(option.label, for: questionID)");
    expect(conversation).toMatch(/if asked\.multiSelect \{[\s\S]*toggleSelection[\s\S]*\} else \{[\s\S]*onAnswer\(option\.label\)/);
    expect(conversation).toContain('onAnswer(selected.joined(separator: ", "))');
    expect(conversation).toContain('selected.isEmpty ? "Submit selections"');
    expect(conversation).toContain(".disabled(selected.isEmpty)");
    expect(dashboard).toMatch(/onAnswer: \{ label in[\s\S]*\.inject\([\s\S]*text: label/);
  });

  test("machine-authored materials decode and render inline, including local images", () => {
    expect(models).toContain("case user, assistant, thinking, tool, material, review");
    expect(models).toContain("struct Material: Decodable");
    expect(models).toContain("let material: Material?");
    expect(conversation).toContain("case .material:");
    expect(conversation).toContain("MaterialRow(material: item.material, fallback: item.text)");
    expect(conversation).toContain("NSImage(contentsOfFile: path)");
    expect(conversation).toContain("Image(nsImage: image)");
  });

  test("Mac failures use the daemon control channel with app and UI state", () => {
    expect(socket).toContain('let kind = "app-error"');
    expect(socket).toContain('let source = "mac"');
    expect(socket).toContain("let state: [String: String]");
    expect(socket).toMatch(/func reportAppError\([\s\S]*_ = await request\(/);
    expect(macApp).toContain('operation: "login-item.register"');
    expect(app("StateStore.swift")).toContain("private var errorStateSnapshot: [String: String]");
  });
});
