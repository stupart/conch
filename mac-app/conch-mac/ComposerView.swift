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
    /// The last dictation applied, kept BESIDE the drafts rather than in memory.
    ///
    /// `live.dictated` is sticky on the daemon's side and deliberately never cleared — it has to outlive the state
    /// transitions that follow it, because the app applies it whenever it next reads state. The guard that makes that
    /// safe is the id. Holding the id only in memory meant every relaunch reset it to 0, so a dictation the user had
    /// already received — and deleted — looked new again and was appended once more. Tyler, after a dozen rebuilds:
    /// "this text keeps showing in the 'arch prime' session input box. i keep delting it and it keeps coming back."
    private static let appliedDictationKey = "conch.mac.appliedDictationID.v1"

    /// One store for the dashboard's composer and the conversation fog (M3), so a session has one draft
    /// wherever it is typed, and a dictation lands in it once however many views are watching.
    static let shared = ComposerDraftStore()

    @Published private var drafts: [String: Entry]
    /// The last dictation applied. State republishes several times a second, so without this the same
    /// spoken sentence would be appended over and over.
    private var appliedDictationID: Int
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
        appliedDictationID = defaults.integer(forKey: Self.appliedDictationKey)
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
        defaults.set(dictated.id, forKey: Self.appliedDictationKey)
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
        // `.cbox.drop{box-shadow:0 0 0 2px #0A84FF,var(--shFloat)}` — 2 pt, the system drop
        // blue, on the CARD. It was a 1.5 pt cyan rect at radius 8, drawn after the card's
        // own 16 pt padding, so it floated off the edge at the wrong corner radius and in the
        // colour this app uses for the microphone. Tyler: "process was kinda weird, and idk
        // if it worked or not" — a drop target has one job, which is to say "here".
        .overlay {
            if isTargetedForDrop {
                RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous)
                    .strokeBorder(ConchPalette.dropTarget, lineWidth: 2)
            }
        }
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
    }

    private var composerField: some View {
        ZStack(alignment: .topLeading) {
            // Dictation takes over the field while you speak. It is deliberately
            // not written INTO the draft: the transcript is still being revised
            // right up until it lands, and typing over a moving target is worse
            // than watching it settle.
            if !dictation.isEmpty {
                Text(dictation)
                    // `#cLive{padding:8px 10px 4px;font:var(--read)/22px var(--sans)}` — the
                    // live line shares the editor's font AND its insets in the lab, because
                    // this text becomes that text. At 12.5 with 6/8 padding the words changed
                    // size and moved the instant transcription landed, which is precisely the
                    // moment you are watching them.
                    //
                    // The colour is left alone: the lab sets `--text` here (and `--text3`
                    // while transcribing) where the app speaks in cyan, and that is a
                    // state-colour decision rather than a measurement.
                    .font(ConchType.readingBody)
                    .foregroundStyle(ConchPalette.brandCyan)
                    .padding(.top, Self.fieldInsetTop)
                    .padding(.bottom, Self.fieldInsetBottom)
                    .padding(.horizontal, Self.fieldInsetX)
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
                    .conchTextViewInsets(lineSpacing: ConchType.readingLineSpacing)
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
                    // The editor slides DOWN by the same half-leading its glyphs are raised
                    // by inside their line fragment, so the words land exactly where the
                    // placeholder draws them and only the caret has moved. Top and bottom trade
                    // the same 2 pt, so the field's height, and the gap to the controls under
                    // it, are both unchanged. See `ComposerCaretBaseline`.
                    .padding(.top, Self.fieldInsetTop + Self.caretRaise)
                    .padding(.bottom, Self.fieldInsetBottom - Self.caretRaise)
                    .padding(.horizontal, Self.fieldInsetX)
                    .background(ComposerPasteBridge { urls in attach(urls) })

                if draft.isEmpty {
                    Text(noTerminal ?? "Message \(sessionLabel)")
                        .font(ConchType.readingBody)
                        .foregroundStyle(ConchPalette.textDim)
                        // `.leading` centred it in the field's height, which is the whole
                        // grown box — so it drifted further from the first line the taller
                        // the draft got. The editor lays its first line out at the TOP; the
                        // placeholder has to do the same or they are two different rules
                        // positioning one line of text.
                        .frame(height: fieldHeight, alignment: .topLeading)
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

    /// Half the leading: what the caret moves down, and what the glyphs move up to meet it.
    /// The two halves cancel for the words and do not for the caret — `ComposerCaretBaseline`
    /// has the measurements.
    static let caretRaise: CGFloat = ConchType.readingLineSpacing / 2

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
        // The editor renders `ConchType.readingBody` — system 15 — in a 22 pt line box. This
        // measured at 12.5, whose line height is 15 pt: every wrapped line was measured 7 pt
        // short, so the box grew less than the text it had to hold. Measure what is drawn.
        let font = NSFont.systemFont(ofSize: 15)
        // The same leading the editor lays out with, or the box is measured against a
        // different shape from the one drawn. `Self.lineHeight` still bounds it below and at
        // eight lines — `#ta{max-height:calc(22px * 8 + 12px)}`.
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = ConchType.readingLineSpacing
        let attributed = NSAttributedString(
            string: text,
            attributes: [.font: font, .paragraphStyle: paragraph]
        )
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
        // `#cAtt{display:flex;gap:6px;padding:6px 6px 2px}`. The strip was capped at
        // `maxHeight: 48` around tiles the lab draws 52 tall, so every attachment was
        // clipped by its own container.
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments, id: \.self) { url in
                    AttachmentPreview(url: url) { onRemove(url) }
                }
            }
        }
        .padding(.top, 6)
        .padding(.horizontal, 6)
        .padding(.bottom, 2)
    }
}

private struct AttachmentPreview: View {
    let url: URL
    let onRemove: () -> Void

    private var image: NSImage? { NSImage(contentsOf: url) }

    @ViewBuilder
    var body: some View {
        if let image {
            // `.att{height:52px;border-radius:9px;box-shadow:inset 0 0 0 .5px var(--hair2)}`
            // and `.att.img{width:68px}`. It was 54x44 at radius 6 — a different shape from
            // the lab's in both dimensions, which is what made a row of them look crooked.
            ZStack(alignment: .topTrailing) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 68, height: 52)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .strokeBorder(ConchPalette.hairlineStrong, lineWidth: 0.5)
                    }

                removeButton
                    .padding(4)
            }
            .help(url.lastPathComponent)
        } else {
            // `.att.fl{height:52px;gap:8px;padding:0 30px 0 10px;background:var(--fill);
            // font-size:12.5px;max-width:220px}` — the same 52 as an image tile, so a file
            // and a picture sit on one line rather than two different heights.
            HStack(spacing: 8) {
                Image(systemName: "paperclip")
                    .font(.system(size: 11))
                Text(url.lastPathComponent)
                    .font(ConchTypography.font(size: 12.5))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .foregroundStyle(ConchPalette.textDim)
            .padding(.leading, 10)
            .padding(.trailing, 30)
            .frame(height: 52)
            .frame(maxWidth: 220)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous).fill(ConchPalette.fill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(ConchPalette.hairlineStrong, lineWidth: 0.5)
            )
            .overlay(alignment: .trailing) { removeButton.padding(.trailing, 4) }
            .help(url.path)
        }
    }

    /// `.att .x{width:18px;height:18px;border-radius:50%;background:rgba(29,29,31,.62);
    /// color:#fff}` — it was 14x14 on the window ground at 88%, which on a pale screenshot
    /// was a grey dot on a grey picture.
    private var removeButton: some View {
        Button(action: onRemove) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(Circle().fill(Color(red: 0.114, green: 0.114, blue: 0.122).opacity(0.62)))
        }
        .buttonStyle(.plain)
        .help("Remove \(url.lastPathComponent)")
    }
}

/// The caret straddles the words instead of riding above them.
///
/// Tyler: the cursor "rides high". Measured off the running app at 2x, focused and empty: the
/// caret's ink spans 108..143 while the placeholder's spans 115..142 — 7 px of caret above the
/// words and 1 px below them. Nothing is wrong with the leading. AppKit draws the caret to the
/// LINE FRAGMENT, whose top is the ASCENT, and the reading font clears the cap line by 3.9 pt
/// up top while its descent only just clears the descender.
///
/// Everything closer to the caret was tried first, each with a compiled probe against a real
/// NSTextView, because two earlier attempts at "the caret" reasoned from simplified probes and
/// shipped the wrong fix:
///
///     drawInsertionPoint(in:color:turnedOn:)  never called — under TextKit 2 the caret is an
///                                             NSTextInsertionIndicator SUBVIEW
///     that subview's bounds / layer transform  AppKit rewrites both on the next keystroke
///     .baselineOffset on the text              absorbed by the typesetter under BOTH TextKits:
///                                              the line grows, the ink does not move
///     this delegate, under TextKit 1           glyph ink 72..99 -> 68..95, caret 64..99 in both
///                                              runs: 8 px above / 0 below becomes 4 and 4
///
/// So the glyphs rise half the leading INSIDE the fragment while the fragment — the caret — stays
/// where it was, and `ComposerView.caretRaise` slides the whole editor back down by that same
/// half. The words do not move by a pixel; only the caret does.
private final class ComposerCaretBaseline: NSObject, NSLayoutManagerDelegate {
    /// AppKit holds a layout manager's delegate weakly, and this one is stateless and the same
    /// for every composer, so one instance is kept alive here rather than parked on each view.
    static let shared = ComposerCaretBaseline()

    func layoutManager(
        _ layoutManager: NSLayoutManager,
        shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<NSRect>,
        lineFragmentUsedRect: UnsafeMutablePointer<NSRect>,
        baselineOffset: UnsafeMutablePointer<CGFloat>,
        in textContainer: NSTextContainer,
        forGlyphRange glyphRange: NSRange
    ) -> Bool {
        baselineOffset.pointee -= ConchType.readingLineSpacing / 2
        return true
    }
}

private extension View {
    /// Drop NSTextView's built-in padding so SwiftUI's padding is the only one
    /// in play. Without this the editor applies its inset on top of ours and
    /// typed text lands above centre while the placeholder does not.
    /// `lineSpacing` is passed rather than read off `ComposerView`: inside a `View`
    /// extension, a bare name like `lineHeight` resolves to SwiftUI's own modifier instead
    /// of the struct's constant, and the compiler says so in types.
    func conchTextViewInsets(lineSpacing: CGFloat) -> some View {
        introspectTextView { view in
            view.textContainerInset = .zero
            view.textContainer?.lineFragmentPadding = 0
            // `#ta{font:var(--read)/22px}` — 22 pt between lines, which is 15 pt of type plus
            // 4 pt of leading: `ConchType.readingLineSpacing`, the same number the transcript
            // already uses so the composer and the messages it answers cannot drift apart.
            //
            // It must be lineSpacing, NOT min/maxLineHeight. CSS splits a line box's extra
            // leading half above and half below; AppKit puts ALL of it above the baseline. So
            // asking for a 22 pt line box pushed the first line down and grew the caret with
            // it, which is how the previous attempt at this made the gap worse:
            //
            //     no style          caret 18 pt, text ink at 4 pt
            //     min/max 22        caret 22 pt, text ink at 8 pt   <- shipped, and wrong
            //     lineSpacing 4     caret 18 pt, text ink at 4 pt
            //
            // The placeholder, top-aligned in the same box, draws its ink at 4 pt. Measured
            // with a compiled probe against a real NSTextView, twice, because reasoning about
            // this got it wrong once already.
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = lineSpacing
            view.defaultParagraphStyle = paragraph
            view.typingAttributes[.paragraphStyle] = paragraph
            // An existing draft was laid out before this ran, so restyle what is already there.
            if let storage = view.textStorage, storage.length > 0 {
                storage.addAttribute(
                    .paragraphStyle,
                    value: paragraph,
                    range: NSRange(location: 0, length: storage.length)
                )
            }
            // The caret straddles the words instead of riding above them —
            // `ComposerCaretBaseline` says why this is the only seam that moves it. Reading
            // `layoutManager` is what puts the view back on TextKit 1, which is the point: the
            // TextKit 2 caret is a subview AppKit re-places on every keystroke, with no seam.
            view.layoutManager?.delegate = ComposerCaretBaseline.shared

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

        /// Is `editor` inside the same composer as the probe? Walking a FIXED number of superviews from the probe
        /// hard-codes how deeply SwiftUI happens to nest `.background(...)` today: one wrapper more or less and the
        /// check fails closed, Cmd+V falls through to the text view's own text-only paste, and a pasted image
        /// disappears with nothing on screen to say so (Tyler: "images I paste into the input box don't show previews
        /// so idk if the paste worked or not"). Walking UP from the probe until an ancestor holds the editor does not
        /// care about the depth, only that they belong to one composer.
        func sharesAnAncestor(with editor: NSView) -> Bool {
            var view = probe?.superview
            while let next = view {
                if editor.isDescendant(of: next) { return true }
                if next === next.window?.contentView { return false }
                view = next.superview
            }
            return false
        }
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
                  coordinator.sharesAnAncestor(with: editor) else {
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
        Self.reach(from: probe, attempts: 10, configure: configure)
        return probe
    }

    /// Walk UP from the probe until an ancestor holds the editor, and look again on the next
    /// runloop turn if the tree is not assembled yet.
    ///
    /// The fixed two-superview hop this replaces did both things wrong: it
    /// hard-coded how deeply SwiftUI nests `.background(...)`, and it assumed the tree was built
    /// by the first async turn. Measured against a real TextEditor in a harness, it came up empty
    /// in 6 launches out of 14 — and when it misses, NOTHING here is applied: the editor keeps
    /// SwiftUI's own 5 pt lineFragmentPadding, with no leading, no caret, no spell checking, and
    /// a dropped file inserting its path as text. It fails silently, which is how a miss this
    /// often stayed invisible.
    private static func reach(
        from probe: NSView,
        attempts: Int,
        configure: @escaping (NSTextView) -> Void
    ) {
        DispatchQueue.main.async {
            var ancestor = probe.superview
            while let next = ancestor {
                if let textView = firstTextView(in: next) {
                    configure(textView)
                    return
                }
                if next === next.window?.contentView { break }
                ancestor = next.superview
            }
            if attempts > 1 { reach(from: probe, attempts: attempts - 1, configure: configure) }
        }
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
