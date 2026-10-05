import AppKit
import ConchDesign
import SwiftTerm
import SwiftUI

// The Terminal tab of a session conch hosts: the session itself, live and typeable.
//
// A session started "In conch" runs in conch's own tmux server (src/conch-tmux.ts). This tab is a real terminal
// emulator (SwiftTerm) running a tmux client attached to that session, in SF Mono and conch's colours. The client is
// `ignore-size`, so a Terminal window attached through "Open in Terminal" keeps its own size. Leaving the tab, or the
// session, ends the client — a detach — and the session keeps running; coming back attaches again, and tmux redraws
// it as it is. What the tab does is decided in ConchDesign (`ConchHostedTerminal`, `ConchTerminalKeys`,
// `ConchEmbeddedTerminalColors`), where it is tested.

/// The tab's content: a line saying whose session this is, with "Open in Terminal", over the terminal.
struct HostedTerminalPane: View {
    let row: SessionRow
    let hosted: ConchHostedTerminal

    @EnvironmentObject private var store: StateStore
    @Environment(\.colorScheme) private var scheme
    /// Why the client stopped, once it has: the session ended, or tmux let go of it.
    @State private var ended: String?
    /// Bumped by "Attach again", so SwiftUI makes a fresh client.
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: 0) {
            bar
            Rectangle().fill(ConchPalette.divider).frame(height: 1)
            if let ended {
                VStack(spacing: 10) {
                    Image(systemName: "terminal")
                        .font(.system(size: 20, weight: .light))
                        .foregroundStyle(ConchPalette.textFaint)
                    Text(ended)
                        .font(ConchTypography.font(size: 12))
                        .foregroundStyle(ConchPalette.textDim)
                        .multilineTextAlignment(.center)
                    Button("Attach again") {
                        self.ended = nil
                        attempt += 1
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HostedTerminalView(hosted: hosted, scheme: scheme) { reason in ended = reason }
                    .id(attempt)
                    .padding(.leading, 8)
                    .padding(.top, 4)
                    .background(ConchEmbeddedTerminalColors.theme(scheme).background.color)
            }
        }
        .background(ConchEmbeddedTerminalColors.theme(scheme).background.color)
    }

    private var bar: some View {
        HStack(spacing: 8) {
            Image(systemName: "terminal")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)
            Text("\(ConchTerminalAgent.name(backend: row.backend)) · in conch")
                .font(ConchTypography.font(size: 12, weight: .medium))
                .foregroundStyle(ConchPalette.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button { store.openInTerminal(row) } label: {
                HStack(spacing: 4) {
                    Text("Open in Terminal")
                    Image(systemName: "arrow.up.forward")
                        .font(.system(size: 9, weight: .semibold))
                }
                .font(ConchTypography.font(size: 11))
                .foregroundStyle(ConchPalette.textDim)
                .padding(.horizontal, 8)
                .frame(height: 22)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Show this session in a Terminal window too. Both stay live; closing the window only detaches it.")
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
    }
}

/// SwiftTerm, attached to the session. Made when the tab appears; ended (a detach) when SwiftUI takes it down, which is
/// what leaving the tab or the session does.
struct HostedTerminalView: NSViewRepresentable {
    let hosted: ConchHostedTerminal
    let scheme: ColorScheme
    let onEnded: (String) -> Void

    func makeNSView(context: Context) -> ConchTmuxTerminalView {
        let view = ConchTmuxTerminalView(frame: .zero)
        view.onEnded = onEnded
        view.apply(scheme)
        view.attach(to: hosted)
        return view
    }

    func updateNSView(_ view: ConchTmuxTerminalView, context: Context) {
        view.onEnded = onEnded
        view.apply(scheme)
    }

    /// Leaving the tab, the session, or the split: the client goes, and the session keeps running in conch's tmux.
    static func dismantleNSView(_ view: ConchTmuxTerminalView, coordinator: ()) {
        view.detach()
    }
}

/// The terminal view: SwiftTerm's local-process view running `tmux … attach-session`, with conch's keys and colours.
///
/// While it has the keyboard it takes every key but Command's, straight from the event stream: Esc, Space, the arrows,
/// Tab and Return are the TUI's, never conch's shortcuts (the dashboard's Space-to-talk, the composer's Return-to-send).
/// Command-keys still reach the menus, so Copy, Paste and ⌘1/⌘2 work as they do everywhere.
final class ConchTmuxTerminalView: LocalProcessTerminalView, ConchOwnsKeyboard {
    var onEnded: ((String) -> Void)?
    /// SwiftTerm holds its process delegate weakly, and the view's own base class already answers some of the
    /// delegate's methods, so the client's exit is heard by an object of its own.
    private lazy var watcher = ClientWatcher(view: self)
    private var keyMonitor: Any?
    private var attached = false
    private var detaching = false
    /// The scheme last drawn in: SwiftUI updates the view far more often than the appearance changes, and each change
    /// of colours redraws the whole screen.
    private var appliedScheme: ColorScheme?

    override init(frame: CGRect) {
        super.init(frame: frame)
        font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        processDelegate = watcher
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        processDelegate = watcher
    }

    deinit {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
    }

    /// conch's surface and text, its active blue for the caret, and sixteen colours that read on them.
    func apply(_ scheme: ColorScheme) {
        guard scheme != appliedScheme else { return }
        appliedScheme = scheme
        let theme = ConchEmbeddedTerminalColors.theme(scheme)
        nativeBackgroundColor = theme.background.nsColor
        nativeForegroundColor = theme.foreground.nsColor
        caretColor = ConchEmbeddedTerminalColors.caret(scheme).nsColor
        selectedTextBackgroundColor = ConchEmbeddedTerminalColors.selection(scheme).over(theme.background).nsColor
        installColors(theme.ansi.map(\.terminalColor))
    }

    /// Start the client: the tmux the server runs, attached to the session by its socket and exact name.
    func attach(to hosted: ConchHostedTerminal) {
        guard !attached else { return }
        guard hosted.isUsable else {
            ended("conch couldn't read where this session runs, so it didn't attach.")
            return
        }
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/tmux").path
        guard let tmux = ConchHostedTerminal.binary(
            published: hosted.tmux,
            bundled: bundled,
            isExecutable: { FileManager.default.isExecutableFile(atPath: $0) }
        ) else {
            ended("conch can't find tmux to attach with.")
            return
        }
        attached = true
        let environment = ConchHostedTerminal.clientEnvironment(ProcessInfo.processInfo.environment)
        startProcess(
            executable: tmux,
            args: hosted.attachArguments,
            environment: environment.map { "\($0.key)=\($0.value)" },
            execName: "tmux",
            currentDirectory: NSHomeDirectory()
        )
    }

    /// End the client, which detaches it; the session keeps running.
    func detach() {
        detaching = true
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        if process?.running == true { terminate() }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        guard let window else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, let window = self.window, event.window === window, window.firstResponder === self else { return event }
            if event.modifierFlags.contains(.command) { return event }
            let flags = event.modifierFlags
            if let bytes = ConchTerminalKeys.bytes(
                keyCode: event.keyCode,
                shift: flags.contains(.shift),
                control: flags.contains(.control),
                option: flags.contains(.option),
                command: false
            ) {
                self.send(bytes)
                return nil
            }
            self.keyDown(with: event)
            return nil
        }
        // Focus goes inside as the tab opens: what you type next is the session's.
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window, self.window === window else { return }
            window.makeFirstResponder(self)
        }
    }

    /// Cmd-V: the text, as a terminal pastes it; an image alone on the clipboard, as Claude Code's own Ctrl-V, which
    /// reads the clipboard itself and attaches the picture, as it does in Terminal.
    override func paste(_ sender: Any) {
        let board = NSPasteboard.general
        let hasText = board.string(forType: .string) != nil
        let hasImage = board.canReadObject(forClasses: [NSImage.self], options: nil)
        switch ConchTerminalKeys.paste(hasText: hasText, hasImage: hasImage) {
        case .text: super.paste(sender)
        case .image: send(ConchTerminalKeys.imagePaste)
        case .nothing: break
        }
    }

    /// The tmux client exited: on its own (the session ended, or tmux let it go), never because conch detached it.
    fileprivate func clientExited(_ exitCode: Int32?) {
        guard !detaching else { return }
        ended(exitCode == 0
            ? "Detached. The session may have ended, or tmux let go of it."
            : "conch couldn't attach to this session.")
    }

    /// Said on the next turn of the run loop: never while SwiftUI is making or updating the view.
    private func ended(_ reason: String) {
        DispatchQueue.main.async { [weak self] in self?.onEnded?(reason) }
    }
}

extension SessionRow {
    /// The session runs in conch's own tmux, in a shape conch attaches to (`ConchHostedTerminal.isUsable`): its Terminal
    /// tab is the session itself. A subagent runs inside its session and has no terminal of its own.
    var hostedTerminal: ConchHostedTerminal? {
        guard parentSessionId == nil, let hosted, hosted.isUsable else { return nil }
        return hosted
    }
}

/// Hears the tmux client exit, for `ConchTmuxTerminalView`.
private final class ClientWatcher: LocalProcessTerminalViewDelegate {
    weak var view: ConchTmuxTerminalView?

    init(view: ConchTmuxTerminalView) {
        self.view = view
    }

    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func processTerminated(source: TerminalView, exitCode: Int32?) {
        view?.clientExited(exitCode)
    }
}

/// A view that takes every key but Command's while it is first responder: the dashboard's single-key shortcuts
/// (`DashboardInputMonitor`) leave its keys alone.
protocol ConchOwnsKeyboard: AnyObject {}

private extension ConchRGBA {
    var nsColor: NSColor {
        NSColor(
            srgbRed: CGFloat(hex >> 16 & 0xFF) / 255,
            green: CGFloat(hex >> 8 & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: CGFloat(alpha)
        )
    }

    /// SwiftTerm's 16-bit channels.
    var terminalColor: SwiftTerm.Color {
        SwiftTerm.Color(red: UInt16(hex >> 16 & 0xFF) * 257, green: UInt16(hex >> 8 & 0xFF) * 257, blue: UInt16(hex & 0xFF) * 257)
    }
}
