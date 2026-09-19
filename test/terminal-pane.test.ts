import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * A terminal in the work half — the last of "a terminal and ... the full file tree and diffs
 * borrowing from this app: https://coteditor.com as well as a browser in the side panel".
 *
 * A COMMAND RUNNER, not an interactive shell, and that was measured rather than chosen. A spike
 * spawned a real /bin/zsh on a real pty and captured what it emitted: an interactive login
 * shell draws its prompt with bracketed paste and nine erase-line plus nine erase-display
 * sequences — all redraw, all of it swallowed by a colour-only parser, so a live prompt would
 * render as artifacts. All eleven NON-interactive captures were pure SGR colour.
 *
 * These read the Swift, since the Mac app has no test target. The parser itself is real unit
 * tests in ConchDesign, against bytes that pty actually produced.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Line comments stripped, so prose describing a rule can never satisfy a guard.
const swift = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");
const terminal = swift("mac-app/conch-mac/Terminal.swift");
const pane = swift("mac-app/conch-mac/DashboardView.swift");
const workspace = swift("design/ConchDesign/Sources/ConchDesign/Workspace.swift");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}
function section(text: string, start: string, end: string): string {
  const a = at(text, start);
  return text.slice(a, at(text, end, a));
}

describe("a command runs where the session runs", () => {
  /**
   * THE one that must never be quietly removed. Without a pager override, `git diff` on a real
   * diff does not render wrong — it HANGS, waiting for a keypress this pane has no way to send.
   * Measured: 723 of 21,934 bytes delivered before the spike had to kill it at 25s. With it:
   * the whole diff, instantly, pure colour.
   */
  test("the pager is disabled, or git diff hangs forever", () => {
    const environment = section(terminal, "static func environment(", "\n    @discardableResult");
    expect(environment).toContain('environment["PAGER"] = "cat"');
    expect(environment).toContain('environment["GIT_PAGER"] = "cat"');
    // Tools ask isatty before they colour anything, so the pty is the point — but they also
    // need to be told what kind of terminal it is.
    expect(environment).toContain('environment["TERM"] = term');
    // The daemon's own PATH builder, not a second copy: a GUI app carries the bare system PATH,
    // so `bun` and `npm` are not on it.
    expect(environment).toContain('DaemonHost.daemonPath(inherited: environment["PATH"])');
  });

  test("one command per run, with no prompt to redraw", () => {
    // `-l` for the login shell's PATH and aliases, `-c` so it runs one command and exits.
    expect(terminal).toContain('arguments: ["-lc", line]');
    expect(terminal).toContain('executable: "/bin/zsh"');
    // The parser is ConchDesign's, not a second one written here.
    expect(terminal).toContain("ConchTerminalOutput()");
    expect(terminal).not.toContain("\\u{1B}[");
  });

  /**
   * forkpty rather than a pipe: through a pipe every tool checks isatty and comes back grey,
   * and colour is exactly the information worth having in test and diff output.
   */
  test("a real pty, reaped as a group", () => {
    expect(terminal).toContain("import Darwin");
    expect(terminal).toContain("forkpty(&descriptor, nil, nil, &size)");
    // forkpty makes the child a session leader, so signalling the GROUP takes the whole
    // pipeline with it instead of orphaning whatever the shell spawned.
    expect(terminal).toContain("killpg(pid, SIGTERM)");
    expect(terminal).toContain("waitpid(pid, &status, 0)");
    // Sized, or anything that formats to the terminal width guesses 80.
    expect(terminal).toContain("ioctl(masterFD, TIOCSWINSZ, &size)");
  });

  /**
   * The fd is closed in the source's CANCEL handler, not after waitpid. A DispatchSource
   * released while still resumed keeps its own reference, so closing anywhere else leaks one
   * descriptor per command in an app that runs for days.
   */
  test("the descriptor is closed by the cancel handler, so a released source cannot leak it", () => {
    const cancel = section(terminal, "reader.setCancelHandler {", "\n        source = reader");
    expect(cancel).toContain("close(self.masterFD)");
    expect(cancel).toContain("self.masterFD = -1");
    expect(terminal).toContain("deinit {");
    expect(section(terminal, "deinit {", "\n}")).toContain("terminate()");
  });

  /**
   * Output arrives on a private queue, never the main thread. Touching view state from there is
   * the classic way a reader like this corrupts SwiftUI.
   */
  test("output crosses to the main actor before it touches the view", () => {
    expect(terminal).toContain('DispatchQueue(label: "conch.pty.io")');
    const output = section(terminal, "session.onOutput = { data in", "session.onExit");
    expect(output).toContain("Task { @MainActor in");
    // A build can print tens of thousands of lines; the oldest go, never the newest.
    expect(output).toContain("output.trim(toLastLines: Self.scrollbackLimit)");
  });
});

describe("the terminal is a third content for the work half", () => {
  test("it is a WorkPane, not a fourth way of splitting the stage", () => {
    expect(workspace).toContain("case terminal");
    // StageMode is untouched: how the stage is split is a different question from what is in it.
    expect(section(workspace, "public enum StageMode", "public enum WorkPane").match(/case \w+/g) ?? [])
      .toHaveLength(3);
  });

  test("it needs somewhere to run, and falls back when there is nowhere", () => {
    const choose = section(pane, "private func workPane(for row: SessionRow) -> WorkPane {", "\n    private func changedFiles");
    expect(choose).toContain("if chosen == .terminal, workingFolder != nil { return .terminal }");
  });

  /**
   * Keyed on the session. A shell started in one session's folder must never be handed to
   * another because SwiftUI reused the view.
   */
  test("a running shell cannot be inherited by another session", () => {
    const content = section(pane, "private func workContent(for row: SessionRow) -> some View {", "\n    private var deliverables");
    expect(content).toContain("TerminalPaneView(cwd: folder).id(row.id)");
  });

  test("its tab sits with the folder, ahead of the outputs", () => {
    const tabs = section(pane, "private func deliverableTabs(", ".padding(.vertical, 5)");
    // Both are the PLACE the session works; the filed work scrolls on the far side of the rule.
    expect(at(tabs, "FilesTab(")).toBeLessThan(at(tabs, "TerminalTab("));
    expect(at(tabs, "TerminalTab(")).toBeLessThan(at(tabs, "ScrollView(.horizontal)"));
    expect(pane).toContain("action: { workspace.show(work: .terminal, for: row.id) }");
    expect(pane).toContain("private struct TerminalTab: View {");
  });
});
