import ConchDesign
import Darwin
import SwiftUI

// Commands, run where the session runs them, without leaving conch.
//
// A COMMAND RUNNER, not an interactive shell, and the distinction is measured rather than
// stylistic. A spike captured `zsh -l` drawing its own prompt: bracketed paste, nine erase-line
// and nine erase-display sequences — all redraw, all of it swallowed by a colour-only parser,
// so a live prompt would render as artifacts. Every one of the eleven NON-interactive captures
// was pure SGR colour. So each run is `zsh -lc <command>`: no prompt to redraw, and output that
// the parser handles exactly.
//
// What it therefore cannot do, said plainly rather than discovered: vim, htop, an interactive
// rebase, or anything that wants a keypress while it runs.

/// A command on a real pseudo-terminal.
///
/// A pty rather than a pipe because tools ask `isatty` before they colour anything: through a
/// pipe `git status` and `bun test` come back grey, which is exactly the information worth
/// having. `forkpty` needs no bridging header and no entitlement — the app is not sandboxed
/// (`ENABLE_APP_SANDBOX = NO`), and this was proven under the shipped hardened-runtime signing
/// rather than assumed.
final class PTYSession {
    private var masterFD: Int32 = -1
    private var pid: pid_t = -1
    private var source: DispatchSourceRead?
    private let ioQueue = DispatchQueue(label: "conch.pty.io")
    private var finished = false

    /// Fires on `ioQueue`, never the main thread. Hop before touching any view state.
    var onOutput: ((Data) -> Void)?
    var onExit: ((Int32) -> Void)?

    private static func cArray(_ values: [String]) -> UnsafeMutablePointer<UnsafeMutablePointer<CChar>?> {
        let buffer = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: values.count + 1)
        for (index, value) in values.enumerated() { buffer[index] = strdup(value) }
        buffer[values.count] = nil
        return buffer
    }

    /// The environment a command should run in.
    ///
    /// `PAGER`/`GIT_PAGER` are not a nicety. Without them `git diff` on a real diff HANGS on the
    /// pager waiting for a keypress there is no way to send — measured at 723 of 21,934 bytes
    /// delivered before it had to be killed. With them: the whole diff, instantly, pure colour.
    ///
    /// PATH comes from the daemon's own builder rather than a second copy: a GUI app carries the
    /// bare system PATH, so `bun` and `npm` are not on it.
    /// Main-actor because `DaemonHost.daemonPath` is: the PATH builder reads app-owned state,
    /// and reusing it is the whole point — a GUI app carries the bare system PATH, so `bun` and
    /// `npm` are not on it. Building a dictionary once per command costs nothing here, and the
    /// alternative was relaxing an isolation rule that belongs to another type.
    @MainActor
    static func environment(term: String = "xterm-256color") -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["TERM"] = term
        environment["PAGER"] = "cat"
        environment["GIT_PAGER"] = "cat"
        environment["PATH"] = DaemonHost.daemonPath(inherited: environment["PATH"])
        return environment
    }

    @discardableResult
    func start(
        executable: String,
        arguments: [String],
        environment: [String: String],
        cwd: String?,
        rows: UInt16 = 24,
        columns: UInt16 = 100
    ) -> Bool {
        // Everything the child touches is built BEFORE forkpty, so between fork and exec it
        // only calls chdir/execve/_exit — the async-signal-safe ones.
        let executablePath = strdup(executable)
        let argv = Self.cArray([executable] + arguments)
        let envp = Self.cArray(environment.map { "\($0.key)=\($0.value)" })
        let directory = cwd.map { strdup($0) }
        var size = winsize(ws_row: rows, ws_col: columns, ws_xpixel: 0, ws_ypixel: 0)

        var descriptor: Int32 = -1
        let child = forkpty(&descriptor, nil, nil, &size)
        if child < 0 { return false }
        if child == 0 {
            if let directory { _ = chdir(directory) }
            execve(executablePath, argv, envp)
            _exit(127)
        }

        pid = child
        masterFD = descriptor
        _ = fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK)
        let reader = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: ioQueue)
        reader.setEventHandler { [weak self] in self?.drain() }
        // The fd is closed HERE rather than in `finish`, so a source released while still
        // resumed cannot leak it — the failure mode a long-lived app would otherwise
        // accumulate one of per command.
        reader.setCancelHandler { [weak self] in
            guard let self, self.masterFD >= 0 else { return }
            close(self.masterFD)
            self.masterFD = -1
        }
        source = reader
        reader.resume()
        return true
    }

    private func drain() {
        var buffer = [UInt8](repeating: 0, count: 1 << 16)
        while true {
            let read = buffer.withUnsafeMutableBytes { Darwin.read(masterFD, $0.baseAddress, 1 << 16) }
            if read > 0 {
                onOutput?(Data(buffer[0..<read]))
                continue
            }
            // EAGAIN means drained for now; anything else means the child is gone (EOF, or EIO
            // once the slave side closes).
            if read < 0, errno == EAGAIN || errno == EINTR { return }
            finish()
            return
        }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        source?.cancel()
        source = nil
        var status: Int32 = 0
        waitpid(pid, &status, 0)
        let code = (status & 0x7F) == 0 ? (status >> 8) & 0xFF : -(status & 0x7F)
        onExit?(Int32(code))
    }

    func write(_ text: String) {
        let bytes = Array(text.utf8)
        var offset = 0
        while offset < bytes.count {
            let written = bytes.withUnsafeBytes { raw in
                Darwin.write(masterFD, raw.baseAddress!.advanced(by: offset), bytes.count - offset)
            }
            if written > 0 { offset += written; continue }
            if written < 0, errno == EAGAIN || errno == EINTR { continue }
            return
        }
    }

    func resize(rows: UInt16, columns: UInt16) {
        guard masterFD >= 0 else { return }
        var size = winsize(ws_row: rows, ws_col: columns, ws_xpixel: 0, ws_ypixel: 0)
        _ = ioctl(masterFD, TIOCSWINSZ, &size)
    }

    /// `forkpty` makes the child a session leader, so signalling the GROUP takes the whole
    /// pipeline with it rather than orphaning whatever the shell had spawned.
    func terminate() {
        guard pid > 0, !finished else { return }
        killpg(pid, SIGTERM)
    }

    deinit {
        terminate()
        source?.cancel()
    }
}

/// The terminal pane: what you ran, and what it printed.
struct TerminalPaneView: View {
    let cwd: String

    @State private var output = ConchTerminalOutput()
    @State private var command = ""
    @State private var running: PTYSession?
    @State private var lastExit: Int32?
    @FocusState private var fieldFocused: Bool

    /// Bounded, because a build can print tens of thousands of lines and nobody scrolls back
    /// that far. The oldest go, never the newest.
    private static let scrollbackLimit = 4_000
    private static let bottom = "conch-terminal-bottom"

    var body: some View {
        VStack(spacing: 0) {
            transcript
            Rectangle().fill(ConchPalette.divider).frame(height: 1)
            prompt
        }
        .background(ConchPalette.surface)
        .onDisappear { running?.terminate() }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(output.lines.enumerated()), id: \.offset) { _, line in
                        TerminalLineView(runs: line)
                    }
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, ConchSpace.x3)
                .padding(.vertical, ConchSpace.x2)
                .textSelection(.enabled)
            }
            .onChange(of: output.lines.count) { _, _ in
                proxy.scrollTo(Self.bottom, anchor: .bottom)
            }
        }
    }

    private var prompt: some View {
        HStack(spacing: ConchSpace.x2) {
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(running == nil ? ConchPalette.textFaint : ConchPalette.statusWaiting)

            TextField("Run a command in \(URL(fileURLWithPath: cwd).lastPathComponent)", text: $command)
                .textFieldStyle(.plain)
                .font(ConchType.code)
                .foregroundStyle(ConchPalette.textPrimary)
                .focused($fieldFocused)
                .onSubmit(run)
                .disabled(running != nil)

            if running != nil {
                Button("Stop") { running?.terminate() }
                    .buttonStyle(.plain)
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.statusNeeds)
            } else if let lastExit, lastExit != 0 {
                Text("exit \(lastExit)")
                    .font(ConchType.code)
                    .foregroundStyle(ConchPalette.statusNeeds)
            }
        }
        .padding(.horizontal, ConchSpace.x3)
        .padding(.vertical, ConchSpace.x2)
        .background(ConchPalette.raised)
    }

    @MainActor
    private func run() {
        let line = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, running == nil else { return }
        command = ""
        lastExit = nil

        var echoed = ConchTerminalStyle()
        echoed.dim = true
        output.appendOwnLine("$ " + line, style: echoed)

        let session = PTYSession()
        session.onOutput = { data in
            guard let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in
                output.append(text)
                output.trim(toLastLines: Self.scrollbackLimit)
            }
        }
        session.onExit = { code in
            Task { @MainActor in
                running = nil
                lastExit = code
                fieldFocused = true
            }
        }
        // `-l` so the login shell's own PATH and aliases are there, `-c` so it runs one command
        // and exits rather than drawing a prompt this pane cannot redraw.
        guard session.start(
            executable: "/bin/zsh",
            arguments: ["-lc", line],
            environment: PTYSession.environment(),
            cwd: cwd
        ) else {
            output.appendOwnLine("conch could not start a shell.", style: echoed)
            return
        }
        running = session
    }
}

private struct TerminalLineView: View {
    let runs: [ConchTerminalRun]

    var body: some View {
        // An empty line still needs height, or blank output collapses the transcript.
        if runs.isEmpty {
            Text(" ").font(ConchType.code)
        } else {
            runs.reduce(Text("")) { text, run in
                text + Text(run.text)
                    .foregroundColor(TerminalPalette.colour(run.style))
                    .fontWeight(run.style.bold ? .semibold : .regular)
                    .italic(run.style.italic)
                    .underline(run.style.underline)
            }
            .font(ConchType.code)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// ANSI's eight colours, in conch's own terms.
///
/// Not the raw ANSI values: pure `#00FF00` on a dark panel is a different design language from
/// everything around it. These lean on the palette the app already uses for the same meanings —
/// a failing test is `statusNeeds`, a passing one `statusReview` — so command output reads as
/// part of conch rather than as a terminal pasted into it.
private enum TerminalPalette {
    static func colour(_ style: ConchTerminalStyle) -> Color {
        guard let colour = style.colour else {
            return style.dim ? ConchPalette.textFaint : ConchPalette.textPrimary
        }
        let base: Color = switch colour {
        case .black: ConchPalette.textFaint
        case .red: ConchPalette.statusNeeds
        case .green: ConchPalette.statusReview
        case .yellow: ConchPalette.statusWaiting
        case .blue: ConchPalette.brandCyan
        case .magenta: ConchPalette.statusMicOpen
        case .cyan: ConchPalette.brandCyan
        case .white: ConchPalette.textPrimary
        }
        return style.dim ? base.opacity(0.7) : base
    }
}
