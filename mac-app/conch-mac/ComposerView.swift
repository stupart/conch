import SwiftUI
import ConchDesign
import UniformTypeIdentifiers

/// Unsent work belongs to the session it addresses, not to whichever row is
/// currently occupying the composer. Keeping the whole entry here also makes
/// text and files switch atomically; splitting them lets an attachment follow a
/// different draft and recreates the same wrong-agent failure in another form.
@MainActor
final class ComposerDraftStore: ObservableObject {
    private struct Entry: Codable {
        var text = ""
        var attachments: [URL] = []

        var isEmpty: Bool { text.isEmpty && attachments.isEmpty }
    }

    private static let defaultsKey = "conch.mac.composerDrafts.v1"

    /// One store for the dashboard's composer and the conversation fog (M3), so a session has one draft
    /// wherever it is typed, and a dictation lands in it once however many views are watching.
    static let shared = ComposerDraftStore()

    @Published private var drafts: [String: Entry]
    /// The last dictation applied. State republishes several times a second, so without this the same
    /// spoken sentence would be appended over and over.
    private var appliedDictationID = 0
    private let defaults: UserDefaults
    private var previewSeed: String?
    /// The pending save. Saving every keystroke JSON-encoded every draft and wrote it to preferences; with a long
    /// draft that froze the app (a sample on 2026-09-14 had ComposerDraftStore.persist heaviest on the main thread),
    /// and each write woke everything watching preferences. It now saves once typing pauses, and when the app quits.
    private var saveTask: Task<Void, Never>?
    private var terminateObserver: NSObjectProtocol?

    init(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.defaults = defaults
        previewSeed = environment["CONCH_COMPOSER_TEXT"]
        if let data = defaults.data(forKey: Self.defaultsKey),
           let saved = try? JSONDecoder().decode([String: Entry].self, from: data) {
            drafts = saved.filter { !$0.value.isEmpty }
        } else {
            drafts = [:]
        }
        terminateObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.saveNow() }
        }
    }

    func textBinding(for sessionID: String) -> Binding<String> {
        Binding(
            get: { [weak self] in self?.drafts[sessionID]?.text ?? "" },
            set: { [weak self] text in
                self?.update(sessionID) { $0.text = text }
            }
        )
    }

    func attachmentsBinding(for sessionID: String) -> Binding<[URL]> {
        Binding(
            get: { [weak self] in self?.drafts[sessionID]?.attachments ?? [] },
            set: { [weak self] attachments in
                self?.update(sessionID) { $0.attachments = attachments }
            }
        )
    }

    /// Screenshot automation needs non-empty text to exercise field layout. It
    /// may seed only the first presented session; showing it under every session
    /// would teach the preview path the exact ownership bug this store prevents.
    func claimPreviewSeed(for sessionID: String) {
        guard let previewSeed else { return }
        self.previewSeed = nil
        guard !previewSeed.isEmpty, drafts[sessionID] == nil else { return }
        update(sessionID) { $0.text = previewSeed }
    }

    /// Add spoken words to what is already typed, rather than replacing it.
    ///
    /// The whole point of dictating into a composer is that the two can be
    /// combined — start typing, finish out loud, edit the join. Overwriting
    /// would reproduce the bug from the other direction.
    func appendDictation(_ text: String, to sessionID: String) {
        let spoken = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return }
        update(sessionID) { entry in
            let existing = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
            entry.text = existing.isEmpty ? spoken : existing + " " + spoken
        }
    }

    /// A finished dictation, applied once by its id, to the session that asked for it.
    func apply(_ dictated: Dictation?) {
        guard let dictated, dictated.id != appliedDictationID else { return }
        appliedDictationID = dictated.id
        appendDictation(dictated.text, to: dictated.sessionId)
    }

    private func update(_ sessionID: String, mutate: (inout Entry) -> Void) {
        let before = drafts[sessionID]
        var entry = before ?? Entry()
        mutate(&entry)
        // Nothing changed (a view re-sending the same text): no publish, no save.
        guard entry.text != (before?.text ?? "") || entry.attachments != (before?.attachments ?? []) else { return }
        if entry.isEmpty {
            drafts[sessionID] = nil
        } else {
            drafts[sessionID] = entry
        }
        scheduleSave()
    }

    /// Saves half a second after the last change, so typing costs nothing but the keystroke.
    // ponytail: up to half a second of typing is unsaved if conch is killed outright; quitting saves at once.
    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            self?.persist()
        }
    }

    func saveNow() {
        saveTask?.cancel()
        saveTask = nil
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(drafts) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}

/// Type to a session from the Mac, with images.
///
/// conch could speak to an agent and the phone could type to one, but the Mac
/// app — the window actually open on the machine the agents are running on —
/// was read-only. Tyler put it plainly: "i can't even input text or images on
/// our mac app yet lol".
///
/// Images do NOT need the phone's upload dance. That exists because a picture
/// on a phone is not on the Mac; here the file is already local, so the agent
/// can read it straight off disk and all we have to send is the path. No
/// resizing either — downscaling exists to avoid pushing pixels over a metered
/// relay, and there is no relay in this direction.
struct ComposerView: View {
    let sessionID: String
    let sessionLabel: String
    /// Which agent this is going to, for the destination chip.
    var backend: String? = nil
    @Binding var draft: String
    @Binding var attachments: [URL]
    /// What conch is hearing right now, so dictation appears where you would
    /// type it rather than somewhere else on screen.
    let dictation: String
    /// True while the agent is mid-turn, which is the only time stopping means
    /// anything.
    let isWorking: Bool
    /// What conch's microphone is doing right now: "", "listening", "recording",
    /// "transcribing", "speaking".
    let voiceState: String
    /// How loud the mic is, 0..1, while recording. It drives the halo, so the
    /// button says "I can hear you" rather than only "I am on".
    let voiceLevel: Double
    /// C9b Cut B: another Mac holds this daemon's voice and ear. The mic is the
    /// one control here that would open it, so it alone is dimmed and disabled;
    /// typing, attaching and sending keep working.
    var audioHeldElsewhere = false
    /// Why this session has no terminal to type into (a closed Codex thread,
    /// or one an app-server hosts). Send and Stop need one, so both are off
    /// and the field says why; the mic and recite keep working.
    var noTerminal: String? = nil
    /// Present when the session is a background job no window is attached to:
    /// the way to a terminal that can type to it, beside the reason there is none.
    var onOpenInTerminal: (() -> Void)? = nil
    let onSend: (String) -> Task<Bool, Never>
    let onInterrupt: () -> Void
    let onTalk: () -> Void
    let onRecite: () -> Void
    /// Called the moment a draft becomes non-empty, so the pane can stop
    /// following whichever session happens to be busiest.
    let onDraftStarted: () -> Void
    /// Bumped by anything that wants the cursor here — a question's "Something
    /// else…" row, today. A counter rather than a Bool because the request is
    /// an event, and the same request can arrive twice in a row.
    var focusRequest: Int = 0

    @State private var isTargetedForDrop = false
    @State private var isSending = false
    /// The field's real width, so height can be measured rather than guessed.
    @State private var fieldWidth: CGFloat = 0
    @FocusState private var fieldFocused: Bool

    var body: some View {
        // No gap: `#ta` carries its own 4 of bottom padding and `.cbar` its own 34 height,
        // so a stack spacing here is height the lab does not have.
        VStack(alignment: .leading, spacing: 0) {
            if !attachments.isEmpty {
                AttachmentStrip(attachments: attachments) { url in
                    attachments.removeAll { $0 == url }
                }
            }

            // The field first, controls beneath — the phone's layout, adopted.
            //
            // Everything used to sit in one row, so as the text grew the
            // buttons stayed vertically centred in a column several lines tall
            // and floated in the middle of empty space, with send drifting down
            // the right. A row of controls under the text keeps them where your
            // hand left them however tall the message gets, and gives the text
            // the full width instead of the gap between two button clusters.
            composerField

            HStack(alignment: .center, spacing: 4) {
                Button(action: chooseFiles) {
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .medium))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .foregroundStyle(ConchPalette.textDim)
                .help("Attach an image")

                // Speech belongs HERE, not in a bar at the far edge of the
                // window. Talking is what conch is for, and the control for it
                // was further from the text field than the button that attaches
                // a picture. It also carries the state: the only feedback that
                // dictation was working at all used to be a hint appearing
                // somewhere else entirely.
                Button(action: onTalk) {
                    Image(systemName: micSymbol)
                        .font(.system(size: 12, weight: .medium))
                        // `.mic` is 30 in the lab, where the plain icon buttons are 28: the one
                        // control always worth hitting is a little larger than its neighbours.
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(micBackground))
                        .foregroundStyle(micForeground)
                        // Armed and waiting: the fixed pulse. Hearing you: the
                        // halo, sized by the level the recorder reports ten
                        // times a second. It pulsed identically whether conch
                        // was hearing you or hearing nothing, which was exactly
                        // the state the missing mic permission hid.
                        .symbolEffect(.variableColor.iterative, isActive: voiceState == "listening")
                        .overlay(
                            Circle()
                                .stroke(ConchPalette.brandCyan.opacity(0.25 + 0.75 * voiceLevel), lineWidth: 2)
                                .scaleEffect(1 + 0.6 * voiceLevel)
                                .opacity(voiceState == "recording" ? 1 : 0)
                                .animation(.easeOut(duration: 0.12), value: voiceLevel)
                        )
                }
                .buttonStyle(.plain)
                .disabled(audioHeldElsewhere)
                .opacity(audioHeldElsewhere ? 0.35 : 1)
                .help(audioHeldElsewhere ? "Controlled by another Mac — press Take it to talk here" : micHelp)
                .accessibilityLabel(audioHeldElsewhere ? "Controlled by another Mac — press Take it to talk here" : micHelp)

                if let micCaption {
                    Text(micCaption)
                        .font(ConchTypography.font(size: 12, weight: .medium))
                        .foregroundStyle(micCaptionColor)
                        .transition(.opacity)
                        .fixedSize()
                }

                // `.dest` — where this message is going. The brief asked for it, and so did the
                // Codex review: "show the destination beside the composer". A composer with no
                // destination is how a sentence meant for one agent goes to another.
                HStack(spacing: 5) {
                    AgentBadge(backend: backend)
                    Text(sessionLabel)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .font(ConchTypography.font(size: 12))
                .foregroundStyle(ConchPalette.textFaint)
                .padding(.leading, 8)
                .layoutPriority(-1)

                if noTerminal != nil, let onOpenInTerminal {
                    Button(action: onOpenInTerminal) {
                        Label("Open in Terminal", systemImage: "terminal")
                            .font(ConchTypography.font(size: 11, weight: .medium))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(ConchPalette.brandCyan)
                    .help("Open this session in a new Terminal window")
                    .accessibilityLabel("Open \(sessionLabel) in Terminal")
                    .fixedSize()
                }

                Spacer(minLength: 8)

                // Read that back to me.
                //
                // `r` used to do this, and stopped working the day a text field
                // appeared: the key monitor disables itself whenever something
                // editable has focus, which is correct — you cannot have a
                // composer and single-letter shortcuts at once — but it silently
                // took the feature with it. A button cannot be shadowed by a
                // text field.
                Button(action: onRecite) {
                    // A counterclockwise arrow reads as UNDO, which beside a
                    // mic is an alarming thing to offer by accident — Tyler had
                    // to ask twice what it did. This one says "sound", which is
                    // what it does.
                    Image(systemName: "speaker.wave.2.circle")
                        .font(.system(size: 13, weight: .medium))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .foregroundStyle(ConchPalette.textDim)
                .help("Read the last reply again")
                .accessibilityLabel("Read the last reply again")

                // Send becomes Stop while a turn is running. One control in
                // one place: the button you reach for is always the one that
                // acts on the turn in front of you, and a stray Return cannot
                // queue text at the moment you meant to interrupt.
                if isWorking && composed.isEmpty {
                    Button(action: onInterrupt) {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .frame(width: 28, height: 28)
                            .background(Circle().fill(ConchPalette.statusWaiting))
                            .foregroundStyle(Color.black)
                    }
                    .buttonStyle(.plain)
                    .disabled(noTerminal != nil)
                    .help(noTerminal ?? "Stop this turn")
                } else {
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .semibold))
                        // `.send` is 30 like the mic, not 28 like the icon buttons.
                        .frame(width: 30, height: 30)
                        // `.send` in the lab is the accent — near-black ink — not the brand
                        // cyan. Cyan at full strength is reserved for "your microphone is open",
                        // which is the one state with the highest cost of being wrong about, and
                        // a send button wearing it competes with that.
                        .background(
                            Circle().fill(
                                canSend ? ConchPalette.ink : ConchPalette.fill
                            )
                        )
                        .foregroundStyle(canSend ? ConchPalette.onInk : ConchPalette.textFaint)
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: [])
                .help(noTerminal ?? "Send to \(sessionLabel)")
                }
            }
            // `.cbar`: a fixed 34 tall with 2 of leading padding, so the row keeps its height
            // whether or not a caption or destination is showing.
            .frame(height: 34)
            .padding(.leading, 2)
        }
        // .cbox in the lab: 6 all round. This was 14/8, which with the inner box that
        // just went is where the composer's dead height came from.
        .padding(6)
        // §3: the composer floats 14 above the bottom, at the width of the measure, radius 18,
        // floating elevation.
        //
        // It was a full-width bar pinned to the frame with a hairline over it, so the
        // transcript was set to a 700 pt column while the field you answer it in was twice
        // that and touching the edge — the reply and the thing being replied to did not share
        // a column. Same constant as the transcript, so they cannot drift apart.
        .background(
            ConchPalette.surface,
            in: RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous)
        )
        // `--shFloat` is two shadows: a 0.5 px hairline ring AND the soft drop. §3 names the
        // hairline explicitly; conchElevation carries only the drop, so the ring is drawn here.
        .overlay(
            RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous)
                .strokeBorder(ConchPalette.divider, lineWidth: 0.5)
        )
        // The token rather than a hand-rolled shadow: §3 names this elevation, and a literal
        // that happens to look right is how the design system and the app come apart.
        .conchElevation(.floating)
        .frame(maxWidth: ConversationTextView.maxMeasure)
        .padding(.horizontal, 16)
        .padding(.bottom, 14)
        // Dropping a screenshot straight onto the window is how anyone actually
        // shares one, so it must work without opening a file picker first.
        .onDrop(of: [.fileURL], isTargeted: $isTargetedForDrop) { providers in
            load(providers)
            return true
        }
        .onChange(of: focusRequest) { _, _ in
            // Somewhere else asked for the cursor — the "Something else…" row
            // on a question, today. Ignore the initial value so opening a
            // session does not steal focus from whatever you were reading.
            fieldFocused = true
        }
        .overlay {
            if isTargetedForDrop {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(ConchPalette.brandCyan, lineWidth: 1.5)
                    .padding(4)
            }
        }
    }

    private var composerField: some View {
        ZStack(alignment: .topLeading) {
            // Dictation takes over the field while you speak. It is deliberately
            // not written INTO the draft: the transcript is still being revised
            // right up until it lands, and typing over a moving target is worse
            // than watching it settle.
            if !dictation.isEmpty {
                Text(dictation)
                    .font(ConchTypography.font(size: 12.5))
                    .foregroundStyle(ConchPalette.brandCyan)
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)
            } else {
                // TextEditor has no intrinsic content height on macOS — it
                // fills whatever it is given, which turned the composer into a
                // third of the window. Size it from the text instead, so it
                // starts as one line and grows only as far as it earns.
                //
                // It also carries its own text-container inset, which is what
                // made typed text sit high while the placeholder looked fine:
                // the two were being positioned by different rules. Zeroing the
                // inset puts both under the same padding below.
                TextEditor(text: $draft)
                    // Typing here is a claim on this session. Without it the
                    // pane keeps following the live session, so starting a
                    // sentence to one agent and having another begin working
                    // moves the window out from under you mid-word — with the
                    // draft still attached to the session you have just left.
                    .onChange(of: draft) { previous, current in
                        if previous.isEmpty, !current.isEmpty { onDraftStarted() }
                    }
                    // The lab's `#ta` uses the READING font — the composer answers the
                    // transcript, so it is set at the same size rather than a size smaller.
                    .font(ConchType.readingBody)
                    .foregroundStyle(ConchPalette.textPrimary)
                    .scrollContentBackground(.hidden)
                    .focused($fieldFocused)
                    .conchTextViewInsets()
                    .conchSpelling()
                    .frame(height: fieldHeight)
                    // Return SENDS. Tyler kept "trying to send and making a new
                    // line accidentally instead", which is the wrong default for
                    // a chat composer: the common act should be the unmodified
                    // key. Shift-Return still breaks a line for the rare
                    // multi-paragraph message.
                    .onKeyPress(keys: [.return], phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        send()
                        return .handled
                    }
                    .padding(.top, Self.fieldInsetTop)
                    .padding(.bottom, Self.fieldInsetBottom)
                    .padding(.horizontal, Self.fieldInsetX)
                    .background(ComposerPasteBridge { urls in attach(urls) })

                if draft.isEmpty {
                    Text(noTerminal ?? "Message \(sessionLabel)")
                        .font(ConchType.readingBody)
                        .foregroundStyle(ConchPalette.textDim)
                        .frame(height: fieldHeight, alignment: .leading)
                        .padding(.top, Self.fieldInsetTop)
                    .padding(.bottom, Self.fieldInsetBottom)
                        .padding(.horizontal, Self.fieldInsetX)
                        .allowsHitTesting(false)
                }
            }
        }
        // No inner box: §3 says the stage has one card and no others, and the lab draws the
        // placeholder straight onto the composer. A field-shaped rectangle inside a
        // composer-shaped rectangle reads as two controls and costs ~20 pt of height.
        .background(
            GeometryReader { proxy in
                Color.clear.onAppear { fieldWidth = proxy.size.width - Self.fieldInsetX * 2 }
                    .onChange(of: proxy.size.width) { _, width in
                        fieldWidth = width - Self.fieldInsetX * 2
                    }
            }
        )
    }

    /// The mic, said three ways. A person mid-sentence needs to know conch is
    /// hearing them without reading a word.
    private var micSymbol: String {
        switch voiceState {
        case "listening", "recording": return "waveform"
        case "transcribing": return "ellipsis"
        case "speaking": return "speaker.wave.2.fill"
        default: return "mic.fill"
        }
    }

    private var micBackground: Color {
        switch voiceState {
        case "listening", "recording": return ConchPalette.brandCyan
        case "transcribing": return ConchPalette.statusWorking
        case "speaking": return ConchPalette.fill
        default: return ConchPalette.fill
        }
    }

    private var micForeground: Color {
        switch voiceState {
        case "listening", "recording": return .black
        case "transcribing": return .black
        default: return ConchPalette.textDim
        }
    }

    /// The word for what is happening, beside the button.
    ///
    /// Colour alone asks you to remember a legend. One word does not, and this
    /// is the place in the app where knowing the state changes what you do next
    /// — keep talking, wait, or cut in.
    private var micCaption: String? {
        switch voiceState {
        case "listening", "recording": return "listening"
        case "transcribing": return "transcribing"
        case "speaking": return "reading"
        default: return nil
        }
    }

    private var micCaptionColor: Color {
        switch voiceState {
        case "listening", "recording": return ConchPalette.brandCyan
        case "transcribing": return ConchPalette.statusWorking
        case "speaking": return ConchPalette.statusReview
        default: return ConchPalette.textDim
        }
    }

    private var micHelp: String {
        switch voiceState {
        case "listening", "recording": return "Listening — click to stop"
        case "transcribing": return "Transcribing…"
        case "speaking": return "Reading aloud — click to cut in"
        default: return "Talk to this session"
        }
    }

    private var canSend: Bool {
        !composed.isEmpty && !isSending && noTerminal == nil
    }

    /// One shared inset, applied identically to the editor and the placeholder
    /// so a line of text sits in exactly the same place whether or not you have
    /// started typing.
    /// `#ta{padding:8px 10px 4px}` — asymmetric, so the caret sits off the card's top edge
    /// without leaving a gap above the bar.
    static let fieldInsetTop: CGFloat = 8
    static let fieldInsetBottom: CGFloat = 4
    static let fieldInsetX: CGFloat = 10

    /// One line until the text genuinely needs two, then up to six.
    ///
    /// This used to guess at 110 characters per line, which wrapped the field
    /// early on a wide window and late on a narrow one — Tyler noticed it
    /// breaking "earlier than it needs to". A guess cannot be right at two
    /// window widths, so measure: AppKit already knows how tall this string is
    /// at this width, and asking costs one text layout per keystroke against a
    /// draft that is a line or two long.
    private var fieldHeight: CGFloat {
        guard fieldWidth > 1 else { return Self.lineHeight }
        let text = draft.isEmpty ? " " : draft
        let font = NSFont.systemFont(ofSize: 12.5)
        let attributed = NSAttributedString(string: text, attributes: [.font: font])
        let bounds = attributed.boundingRect(
            with: NSSize(width: fieldWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        // A trailing newline has no glyphs, so AppKit measures it as no line at
        // all and the caret would sit below the box you can see.
        let trailing = draft.hasSuffix("\n") ? Self.lineHeight : 0
        let measured = ceil(bounds.height) + trailing
        return min(Self.lineHeight * 8, max(Self.lineHeight, measured))
    }

    /// The lab's `#ta` sets `22px` line height on the reading font.
    private static let lineHeight: CGFloat = 22

    /// Paths first, then the words.
    ///
    /// Both Claude Code and Codex read an image when its path appears in the
    /// message, so an attachment is literally its own absolute path on a line.
    /// Leading rather than trailing because a trailing path after a long
    /// message reads as an afterthought and is easier for a model to skim past.
    private var composed: String {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !attachments.isEmpty else { return text }
        let paths = attachments.map(\.path).joined(separator: "\n")
        return text.isEmpty ? paths : "\(paths)\n\(text)"
    }

    private func send() {
        let payload = composed
        // Return reaches here without the button, so the button's gate is not enough.
        guard noTerminal == nil, !payload.isEmpty else { return }
        let submittedDraft = draft
        let submittedAttachments = attachments
        isSending = true
        let delivery = onSend(payload)
        Task { @MainActor in
            let delivered = await delivery.value
            isSending = false
            fieldFocused = true
            guard delivered else { return }

            // A slow socket write must not erase work typed while it was in
            // flight. Remove only the exact submitted prefix and files; an edit
            // to that prefix is ambiguous, so preserving it is the safe outcome.
            if draft == submittedDraft {
                draft = ""
            } else if !submittedDraft.isEmpty, draft.hasPrefix(submittedDraft) {
                draft.removeFirst(submittedDraft.count)
            }
            attachments.removeAll { submittedAttachments.contains($0) }
        }
    }

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image, .pdf, .plainText]
        guard panel.runModal() == .OK else { return }
        attach(panel.urls)
    }

    private func load(_ providers: [NSItemProvider]) {
        for provider in providers {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url else { return }
                Task { @MainActor in attach([url]) }
            }
        }
    }

    /// The one rule for adding attachments, whether dropped, pasted or picked:
    /// no duplicates, and the first one claims the draft for this session.
    private func attach(_ urls: [URL]) {
        let fresh = urls.filter { !attachments.contains($0) }
        guard !fresh.isEmpty else { return }
        let wasEmpty = attachments.isEmpty
        attachments.append(contentsOf: fresh)
        if wasEmpty { onDraftStarted() }
    }
}

/// Attached images preview as images; other supported files keep the compact
/// filename treatment. The path remains available as hover help for both.
private struct AttachmentStrip: View {
    let attachments: [URL]
    let onRemove: (URL) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments, id: \.self) { url in
                    AttachmentPreview(url: url) { onRemove(url) }
                }
            }
        }
        .frame(maxHeight: 48)
    }
}

private struct AttachmentPreview: View {
    let url: URL
    let onRemove: () -> Void

    private var image: NSImage? { NSImage(contentsOf: url) }

    @ViewBuilder
    var body: some View {
        if let image {
            ZStack(alignment: .topTrailing) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 54, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay {
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(ConchPalette.divider, lineWidth: 0.5)
                    }

                removeButton
                    .padding(3)
            }
            .help(url.lastPathComponent)
        } else {
            HStack(spacing: 5) {
                Image(systemName: "paperclip")
                    .font(.system(size: 9.5))
                Text(url.lastPathComponent)
                    .font(ConchTypography.font(size: 11))
                    .lineLimit(1)
                removeButton
            }
            .foregroundStyle(ConchPalette.textDim)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6).fill(ConchPalette.hover)
            )
            .help(url.path)
        }
    }

    private var removeButton: some View {
        Button(action: onRemove) {
            Image(systemName: "xmark")
                .font(.system(size: 8, weight: .bold))
                .frame(width: 14, height: 14)
                .background(Circle().fill(ConchPalette.bg.opacity(0.88)))
        }
        .buttonStyle(.plain)
        .help("Remove \(url.lastPathComponent)")
    }
}

private extension View {
    /// Drop NSTextView's built-in padding so SwiftUI's padding is the only one
    /// in play. Without this the editor applies its inset on top of ours and
    /// typed text lands above centre while the placeholder does not.
    func conchTextViewInsets() -> some View {
        introspectTextView { view in
            view.textContainerInset = .zero
            view.textContainer?.lineFragmentPadding = 0
            // A dropped file must reach the composer's `.onDrop`, not this
            // editor. NSTextView registers for file drops and inserts the PATH
            // as text, and it is the deeper view under the pointer, so it won
            // every drop on the text area — Tyler dragged two screenshots in
            // and got two paths in the message. Keep every other type (text
            // drags still work); only files are the composer's business.
            let files: Set<NSPasteboard.PasteboardType> = [
                .fileURL, NSPasteboard.PasteboardType("NSFilenamesPboardType"),
            ]
            let kept = view.registeredDraggedTypes.filter { !files.contains($0) }
            view.unregisterDraggedTypes()
            view.registerForDraggedTypes(kept)
        }
    }

    /// Spelling the way the rest of the Mac does it. Nothing turned it on, so
    /// typos went straight into the session. Underlines always; correction and
    /// text replacement only if the person has them on in System Settings.
    /// Smart quotes and dashes stay off: this text lands in terminals and
    /// code, where a curly quote breaks the command.
    func conchSpelling() -> some View {
        introspectTextView { view in
            view.isContinuousSpellCheckingEnabled = true
            view.isAutomaticSpellingCorrectionEnabled = NSSpellChecker.isAutomaticSpellingCorrectionEnabled
            view.isAutomaticTextReplacementEnabled = NSSpellChecker.isAutomaticTextReplacementEnabled
            view.isAutomaticQuoteSubstitutionEnabled = false
            view.isAutomaticDashSubstitutionEnabled = false
        }
    }
}

/// Cmd+V with an image on the clipboard becomes an attachment.
///
/// The editor is an NSTextView, and its own paste knows only text: an image
/// pasted into it either vanished or arrived as a path. A screenshot on the
/// clipboard is the same intent as a dropped one, so it lands the same way.
/// Same shape as the dashboard key monitor — a local keyDown monitor gated on
/// this window and on the composer's editor being first responder — and
/// removed with the view, so a re-rendered composer never stacks two.
private struct ComposerPasteBridge: NSViewRepresentable {
    let onPaste: ([URL]) -> Void

    final class Coordinator {
        var monitor: Any?
        weak var probe: NSView?
        var onPaste: ([URL]) -> Void
        init(onPaste: @escaping ([URL]) -> Void) { self.onPaste = onPaste }
        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onPaste: onPaste) }

    func makeNSView(context: Context) -> NSView {
        let probe = NSView(frame: .zero)
        let coordinator = context.coordinator
        coordinator.probe = probe
        coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "v",
                  let window = coordinator.probe?.window,
                  event.window === window,
                  let editor = window.firstResponder as? NSTextView,
                  editor.isEditable,
                  let container = coordinator.probe?.superview?.superview,
                  editor.isDescendant(of: container) else {
                return event
            }
            let urls = Self.imageAttachments(on: .general)
            guard !urls.isEmpty else { return event } // plain text: the editor's paste
            coordinator.onPaste(urls)
            return nil
        }
        return probe
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onPaste = onPaste
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        if let monitor = coordinator.monitor { NSEvent.removeMonitor(monitor) }
        coordinator.monitor = nil
    }

    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "webp", "tiff"]

    /// Image files on the pasteboard, or image DATA written to a temp file so
    /// it can be attached like any other. Anything else is not ours.
    static func imageAttachments(on pasteboard: NSPasteboard) -> [URL] {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self]) as? [URL] {
            let images = urls.filter { $0.isFileURL && imageExtensions.contains($0.pathExtension.lowercased()) }
            if !images.isEmpty { return images }
        }
        guard let image = NSImage(pasteboard: pasteboard),
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return [] }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("conch-paste-\(UUID().uuidString).png")
        do { try png.write(to: url) } catch { return [] }
        return [url]
    }
}

/// A minimal reach into the NSTextView behind a SwiftUI TextEditor.
///
/// SwiftUI exposes no way to change the text container inset, and the whole
/// bug is that inset. This walks the view tree once on appear rather than
/// taking a dependency for one property.
private struct TextViewIntrospector: NSViewRepresentable {
    let configure: (NSTextView) -> Void

    func makeNSView(context: Context) -> NSView {
        let probe = NSView(frame: .zero)
        DispatchQueue.main.async {
            guard let container = probe.superview?.superview else { return }
            if let textView = Self.firstTextView(in: container) { configure(textView) }
        }
        return probe
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    private static func firstTextView(in view: NSView) -> NSTextView? {
        if let textView = view as? NSTextView { return textView }
        for child in view.subviews {
            if let found = firstTextView(in: child) { return found }
        }
        return nil
    }
}

private extension View {
    func introspectTextView(_ configure: @escaping (NSTextView) -> Void) -> some View {
        background(TextViewIntrospector(configure: configure))
    }
}
