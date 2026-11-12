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
    /// "this text keeps showing in the 'morrow prime' session input box. i keep delting it and it keeps coming back."
    private static let appliedDictationKey = "conch.mac.appliedDictationID.v1"

    /// One store for every composer, so a session has one draft wherever it is typed, and a dictation lands in it once
    /// however many views are watching.
    static let shared = ComposerDraftStore()

    @Published private var drafts: [String: Entry]
    /// Sessions with a send on its way. The session's rather than a view's: the composer can be rebuilt mid-send (another
    /// session shown and back), and the one built again must still know not to send the same words again.
    @Published private(set) var sending: Set<String> = []
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

    func isSending(_ sessionID: String) -> Bool { sending.contains(sessionID) }

    func setSending(_ sessionID: String, _ on: Bool) {
        if on { sending.insert(sessionID) } else { sending.remove(sessionID) }
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
    ///
    /// The join is the live preview's own (`ComposerDictation.appending`), so the words land exactly as the field showed
    /// them while they were spoken (2026-10-05).
    func appendDictation(_ text: String, to sessionID: String) {
        update(sessionID) { entry in
            entry.text = ComposerDictation.appending(text, to: entry.text)
        }
    }

    /// Each session's dictation as it is being spoken, followed frame to frame (`ComposerDictation.Follower`).
    ///
    /// Not published: it is advanced from the state the composer is drawn with, while it draws, and changes nothing
    /// anyone else draws. A following that is published from inside a view's update is SwiftUI's "publishing changes from
    /// within view updates". Here rather than in the view because the composer can be rebuilt mid-dictation, and a view's
    /// own state would start over each time it was.
    private var followers: [String: ComposerDictation.Follower] = [:]
    /// Sessions whose composer mic asked for a dictation, and when, until the capture it asked for is seen. Only those
    /// words go into the draft; the voice loop's reply, the window's Space and the menu bar talk to the session itself.
    private var dictationRequests: [String: Date] = [:]
    /// The mic is slow to open at worst (twelve seconds once, a cold transcript scan), never this slow: a request the
    /// daemon never answered must not make a later voice turn look like a dictation into the draft.
    private static let dictationRequestLifetime: TimeInterval = 60

    /// The composer's own mic asked to dictate into this session's draft (`SessionComposer`).
    func requestDictation(for sessionID: String) {
        dictationRequests[sessionID] = Date()
    }

    /// What the input bar shows for `sessionID` this frame: its draft, then everything said so far, or nil for the draft
    /// alone. 2026-10-05, Tyler: "make the transcript accumulate in the input bar with whatever text is already there
    /// instead of just showing like the last few words". It never writes the draft: only `apply` does, once, when the
    /// finished dictation lands, so a cancelled or failed one leaves the draft exactly as it was. Words that are going to
    /// the session rather than into the draft show alone, as they always did (`ComposerDictation.Follower.composing`).
    func dictationPreview(for sessionID: String, live: ComposerDictation.Live?) -> ComposerDictation.Preview? {
        var follower = followers[sessionID] ?? ComposerDictation.Follower()
        let requested = dictationRequests[sessionID].map { -$0.timeIntervalSinceNow < Self.dictationRequestLifetime } ?? false
        let transcript = live.flatMap {
            follower.follow($0, session: sessionID, applied: appliedDictationID, requested: requested)
        }
        if live == nil { follower = ComposerDictation.Follower() }
        // Answered, or stale: either way it is spent.
        if follower.isFollowing || !requested { dictationRequests[sessionID] = nil }
        followers[sessionID] = follower == ComposerDictation.Follower() ? nil : follower
        return transcript.flatMap {
            ComposerDictation.preview(draft: drafts[sessionID]?.text ?? "", transcript: $0, joining: follower.composing)
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
    /// type it rather than somewhere else on screen: the draft, then every word said so far (`ComposerDictation`), or nil
    /// when this session is not being dictated to.
    let dictation: ComposerDictation.Preview?
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
    var messageRoute: String? = nil
    private var messageUnavailableReason: String? { messageRoute == "codex-app" ? nil : noTerminal }
    /// Present when the session is a background job no window is attached to:
    /// the way to a terminal that can type to it, beside the reason there is none.
    var onOpenInTerminal: (() -> Void)? = nil
    /// This session's skills and commands, read when a draft first begins like a command: the read ⌘K makes on open.
    /// Absent, nothing typed here can reach the agent's own commands (no terminal to type them into), and the composer
    /// offers none.
    var commandCapabilities: (() async -> AgentCapabilities?)? = nil
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
    /// Each video on the composer as it is made ready for the agent, and drops on their way (`ComposerVideos`).
    @ObservedObject private var videos = ComposerVideos.shared
    /// The field has the keyboard; set true to give it the keyboard (`ComposerEditor.isFocused`).
    @State private var fieldFocused = false
    /// A key was typed into the field while it was read-only for a dictation: the caption says why nothing happened,
    /// until the words land.
    @State private var typedWhileDictating = false
    /// The agent's commands offered as they are typed (`SlashTypeahead`, shared with the phone): ↑ ↓ to move, Tab or
    /// Return to choose, Esc to close. 2026-11-04, Tyler: "can u get me access to slash commands on the mobile app and
    /// desktop app?"
    @State private var typeahead = SlashTypeahead()
    /// Where the field's caret is, as it reports it; nil until it has (the end of the draft).
    @State private var caret: Int?
    /// Where a chosen command puts the caret (`ComposerEditor.typeahead`).
    @State private var caretRequest: ComposerCaretRequest?
    /// The session's skills and commands, once read, and whose.
    @State private var commandRead: CommandRead?

    private struct CommandRead: Equatable {
        let session: String
        let capabilities: AgentCapabilities?
    }

    var body: some View {
        // No gap: `#ta` carries its own 4 of bottom padding and `.cbar` its own 34 height,
        // so a stack spacing here is height the lab does not have.
        VStack(alignment: .leading, spacing: 0) {
            if !attachments.isEmpty || !arrivals.isEmpty {
                AttachmentStrip(
                    attachments: attachments,
                    arrivals: arrivals,
                    onRemove: { url in attachments.removeAll { $0 == url } },
                    onDismiss: { id in videos.dismiss(id, from: sessionID) }
                )
            }

            // The commands the first word could be, as a section of this card above the field rather than a popup of
            // their own: the card that holds the words grows to hold them, as it does for attachments.
            if typeaheadShowing {
                SlashTypeaheadList(
                    matches: typeahead.matches,
                    selected: typeahead.selected,
                    surface: .card,
                    onChoose: choose
                )
                // Under the tiles, the highlight keeps the 6 it has from the card's edge, not the strip's 2.
                .padding(.top, attachments.isEmpty && arrivals.isEmpty ? 0 : 4)
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
                .help("Attach pictures, videos or files")

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

                // Given only for a job no window is attached to: one with no terminal yet, or one parked waiting on
                // you, which a send brings back as well (src/parked-jobs.ts).
                if let onOpenInTerminal {
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
                // The same button both ways, like the phone's: while this session
                // is being read aloud it stops the reading. Tyler, 2026-10-08:
                // "i want to be able to click the speak button again and it
                // stops talking". `onTalk` sends `.stop()` while an exchange is
                // active, and speaking is one (`LiveState.isExchangeActive`), so
                // this is the mic's own stop, never a new reading or the mic.
                Button(action: isReadingAloud ? onTalk : onRecite) {
                    // A counterclockwise arrow reads as UNDO, which beside a
                    // mic is an alarming thing to offer by accident — Tyler had
                    // to ask twice what it did. This one says "sound", which is
                    // what it does.
                    Image(systemName: isReadingAloud ? "stop.circle.fill" : "speaker.wave.2.circle")
                        .font(.system(size: 13, weight: .medium))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .foregroundStyle(isReadingAloud ? ConchPalette.textPrimary : ConchPalette.textDim)
                .help(isReadingAloud ? "Stop reading" : "Read the last reply again")
                .accessibilityLabel(isReadingAloud ? "Stop reading" : "Read the last reply again")

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
                .help(messageUnavailableReason ?? videoReadiness ?? "Send to \(sessionLabel)")
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
        .modifier(ComposerCard(isTargetedForDrop: isTargetedForDrop))
        // Dropping a screenshot straight onto the window is how anyone actually
        // shares one, so it must work without opening a file picker first.
        // `.image` as well as `.fileURL`. A drag out of Finder carries a file URL and always
        // worked; a drag from a browser, Preview, Photos or Messages carries image BYTES and
        // matched nothing here, so the drop was refused with no feedback at all — the target
        // never even lit, which is why it read as "doesn't seem to work" rather than as an
        // error. `.image` is the whole tree (png, jpeg, tiff, heic, gif conform to it), the
        // same way the file picker asks for `.image` rather than listing extensions.
        // `.movie` too, for the same reason: a screen recording's thumbnail, a video from Photos or one from a browser is a
        // PROMISED movie, not a file URL, and was refused as image bytes once were (`load`, `ComposerVideos`).
        .onDrop(of: [.fileURL, .movie, .image], isTargeted: $isTargetedForDrop) { providers in
            load(providers)
            return true
        }
        .onChange(of: focusRequest) { _, _ in
            // Somewhere else asked for the cursor — the "Something else…" row
            // on a question, today. Ignore the initial value so opening a
            // session does not steal focus from whatever you were reading.
            fieldFocused = true
        }
        .onAppear(perform: refreshTypeahead)
        .onChange(of: draft) { _, _ in refreshTypeahead() }
        .onChange(of: caret) { _, _ in refreshTypeahead() }
        .onChange(of: commandRead) { _, _ in refreshTypeahead() }
        .onChange(of: sessionID) { _, _ in
            // Another session's draft is another document: its own caret, and its own agent's commands.
            caret = nil
            typeahead = SlashTypeahead()
            refreshTypeahead()
        }
        // Read the first time a draft here begins like a command, as ⌘K reads on open (35-48 ms against real config).
        .task(id: commandsWanted) {
            guard let session = commandsWanted, let commandCapabilities else { return }
            let read = await commandCapabilities()
            guard !Task.isCancelled, session == sessionID else { return }
            commandRead = CommandRead(session: session, capabilities: read)
        }
    }

    // MARK: The slash typeahead

    /// Offered where the agent's own commands can be typed, and not while a dictation fills the field.
    private var typeaheadEnabled: Bool {
        commandCapabilities != nil && dictation == nil && messageUnavailableReason == nil
    }

    private var typeaheadShowing: Bool { typeaheadEnabled && typeahead.isShowing }

    /// The session's agent's own commands at once, its skills and the person's own once they are read.
    private var commandCatalog: [AgentCommand] {
        AgentCommands.all(for: backend, capabilities: commandRead?.session == sessionID ? commandRead?.capabilities : nil)
    }

    /// The session whose skills and commands are wanted and not yet read.
    private var commandsWanted: String? {
        typeaheadEnabled && SlashTypeahead.mayBeginCommand(draft) && commandRead?.session != sessionID ? sessionID : nil
    }

    private func refreshTypeahead() {
        typeahead.setCatalog(commandCatalog)
        typeahead.update(draft: draft, caret: caret)
    }

    /// The editor's keys while the list shows: false hands the key back to the field.
    private func typeaheadKey(_ key: ComposerKey) -> Bool {
        // Against the draft and caret as they are now, not as the last update left them.
        typeahead.update(draft: draft, caret: caret)
        guard typeaheadShowing else { return false }
        switch key {
        case .up: typeahead.move(-1)
        case .down: typeahead.move(1)
        case .escape: typeahead.dismiss()
        case .tab, .enter:
            guard let choice = typeahead.choose(in: draft) else { return false }
            if !choice.unchanged {
                fill(choice)
            } else if key == .enter {
                // Already the whole command, with nothing to add: Return sends it, as it would with no list.
                send()
            }
        }
        return true
    }

    /// A row clicked: filled, never sent, even a line already whole.
    private func choose(_ command: AgentCommand) {
        typeahead.highlight(command)
        if let choice = typeahead.choose(command, in: draft), !choice.unchanged { fill(choice) }
        fieldFocused = true
    }

    private func fill(_ choice: SlashTypeahead.Choice) {
        draft = choice.draft
        caret = choice.caret
        caretRequest = ComposerCaretRequest(at: choice.caret, serial: (caretRequest?.serial ?? 0) + 1)
        fieldFocused = true
    }

    /// The argument a chosen command waits for, drawn after the caret until something is typed there.
    private var argumentPlaceholder: String? {
        typeaheadEnabled ? SlashTypeahead.placeholder(for: draft, caret: caret, in: typeahead.catalog) : nil
    }

    private var composerField: some View {
        ZStack(alignment: .topLeading) {
            // AppKit's text view, owned rather than reached into (`ComposerEditor` says what SwiftUI's TextEditor did
            // to the words in it). It sizes itself from its own layout: one line until the text needs two, then up to
            // eight, measured at the width it is actually laid out at.
            ComposerEditor(text: $draft, isFocused: $fieldFocused, identity: sessionID, onSend: send)
                // Read-only while a dictation fills the field, and a key pressed there says why (`micCaption`).
                // Typing into a draft the dictation is about to be added to would put the words somewhere the
                // field is not showing them; they wait, and Return sends the lot once the words land.
                .readOnly(dictation != nil) { typedWhileDictating = true }
                .typeahead(onKey: typeaheadKey, onCaret: { caret = $0 }, caret: caretRequest)
                // Typing here is a claim on this session. Without it the
                // pane keeps following the live session, so starting a
                // sentence to one agent and having another begin working
                // moves the window out from under you mid-word — with the
                // draft still attached to the session you have just left.
                .onChange(of: draft) { previous, current in
                    if previous.isEmpty, !current.isEmpty { onDraftStarted() }
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
                // Kept where it is while a dictation is drawn over it, not taken out: the draft, the caret, the
                // keyboard and Cmd-Z all stay with it, so the words land in the field you were in and you can
                // carry on typing after them. It used to be swapped out for the dictation line and rebuilt
                // after, which dropped the keyboard and the undo history every time.
                .opacity(dictation == nil ? 1 : 0)
                .allowsHitTesting(dictation == nil)
                .accessibilityHidden(dictation != nil)
                // Nor does it size the field meanwhile: the dictation does. A long draft under a voice turn's one
                // line (`ComposerDictation.Preview.joinsDraft`) held the field eight lines tall around it.
                .frame(height: dictation == nil ? nil : 0, alignment: .top)

            if let dictation {
                // The dictation takes the field while you speak: the draft as it is, then everything said so far,
                // growing as the words arrive (`ComposerDictation`). 2026-10-05, Tyler: "make the transcript
                // accumulate in the input bar with whatever text is already there instead of just showing like the
                // last few words". It showed `partial` alone, the segment being heard, in place of the draft.
                //
                // It is still not written INTO the draft: the transcript is revised right up until it lands, and the
                // draft must be exactly what it was if the dictation is cancelled. Drawn by the editor's own
                // typesetting, at the editor's own insets, so the draft does not move by a pixel when it takes over
                // and none of the words move when they land.
                ComposerDictationText(preview: dictation)
                    .padding(.top, Self.fieldInsetTop + Self.caretRaise)
                    .padding(.bottom, Self.fieldInsetBottom - Self.caretRaise)
                    .padding(.horizontal, Self.fieldInsetX)
                    .help(dictation.joinsDraft
                          ? "Dictating — the words join your message when they land"
                          : "Listening — these words go straight to \(sessionLabel)")
                    .accessibilityElement()
                    .accessibilityLabel(dictation.joinsDraft ? "Dictating" : "Listening")
                    .accessibilityValue(dictation.text)
            } else if let argumentPlaceholder {
                // What the chosen command takes, after the caret: the draft drawn clear in the field's own type, so the
                // hint starts where the next letter will, then the hint in the placeholder's ink. Gone at the first key.
                (Text(draft).foregroundStyle(.clear) + Text(argumentPlaceholder).foregroundStyle(ConchPalette.textDim))
                    .font(ConchType.readingBody)
                    .lineLimit(1)
                    .frame(height: Self.lineHeight, alignment: .topLeading)
                    .padding(.top, Self.fieldInsetTop)
                    .padding(.bottom, Self.fieldInsetBottom)
                    .padding(.horizontal, Self.fieldInsetX)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            } else if draft.isEmpty {
                Text(messageUnavailableReason ?? "Message \(sessionLabel)")
                    .font(ConchType.readingBody)
                    .foregroundStyle(ConchPalette.textDim)
                    // `.leading` centred it in the field's height, which is the whole
                    // grown box — so it drifted further from the first line the taller
                    // the draft got. The editor lays its first line out at the TOP; the
                    // placeholder has to do the same or they are two different rules
                    // positioning one line of text. Empty, the field is one line.
                    .frame(height: Self.lineHeight, alignment: .topLeading)
                    .padding(.top, Self.fieldInsetTop)
                    .padding(.bottom, Self.fieldInsetBottom)
                    .padding(.horizontal, Self.fieldInsetX)
                    .allowsHitTesting(false)
            }
        }
        .onChange(of: dictation == nil) { _, ended in
            if ended { typedWhileDictating = false }
        }
        // No inner box: §3 says the stage has one card and no others, and the lab draws the
        // placeholder straight onto the composer. A field-shaped rectangle inside a
        // composer-shaped rectangle reads as two controls and costs ~20 pt of height.
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
        // What you said going in, a moment before the agent is at work on it: working's blue,
        // as the sidebar draws the same moment. The black ellipsis reads 5.76:1 on it in light, 7.62 in dark.
        case "transcribing": return ConchPalette.statusActive
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
        // The field is read-only while a dictation fills it, and a key pressed there does nothing: this says why, once
        // someone tries (2026-10-05).
        if typedWhileDictating, let dictation {
            return dictation.joinsDraft ? "type once the words land" : "type once the mic closes"
        }
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
        case "transcribing": return ConchPalette.statusActive
        case "speaking": return ConchPalette.statusReview
        default: return ConchPalette.textDim
        }
    }

    /// This session is the one being read aloud: the speaker button stops it.
    private var isReadingAloud: Bool { voiceState == "speaking" }

    private var micHelp: String {
        switch voiceState {
        case "listening", "recording": return "Listening — click to stop"
        case "transcribing": return "Transcribing…"
        // The click sends `.stop()` (onTalk): it stops the reading, it opens nothing (2026-10-08).
        case "speaking": return "Reading aloud — click or press Esc to stop"
        default: return "Talk to this session"
        }
    }

    /// Not while a dictation fills the field: the draft would go without the words still being spoken, and they would
    /// land after it in an empty field. Once they land, Return sends the lot.
    private var canSend: Bool {
        !composed.isEmpty && !isSending && messageUnavailableReason == nil && dictation == nil && videoReadiness == nil
    }

    /// Why the videos on it hold the send, or nil: one still being made ready, or one that can't go until it is taken off
    /// (`VideoAttachment.readiness`). Its tile says which.
    private var videoReadiness: String? {
        VideoAttachment.readiness(attachments.filter(VideoAttachment.isVideo).map { videos.status(of: $0) })
    }

    /// This session's drops on their way, and the ones that never arrived.
    private var arrivals: [ComposerVideos.Arrival] { videos.arrivals[sessionID] ?? [] }

    /// A send of this session's on its way, pressed here or wherever the input was when it was pressed.
    private var isSending: Bool { ComposerDraftStore.shared.isSending(sessionID) }

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

    /// The lab's `#ta` sets `22px` line height on the reading font (`ComposerEditing.lineHeight`).
    private static let lineHeight = ComposerEditing.lineHeight

    /// Paths first, then each video, then the words.
    ///
    /// Both Claude Code and Codex read an image when its path appears in the
    /// message, so an attachment is literally its own absolute path on a line.
    /// Leading rather than trailing because a trailing path after a long
    /// message reads as an afterthought and is easier for a model to skim past.
    /// Neither can watch a video, so a video goes as the phone's does: its contact sheet, its frames and words, timed,
    /// and its path, for people (`VideoAttachment.message`, `ComposerVideos`).
    private var composed: String {
        VideoAttachment.message(text: draft, attachments: attachments) { videos.block(for: $0) }
    }

    private func send() {
        // Return reaches here without the button, so the button's own gate is asked again here, all of it: with a send
        // still on its way, Return sent the same words a second time.
        guard canSend else { return }
        let payload = composed
        let submittedDraft = draft
        let submittedAttachments = attachments
        let session = sessionID
        ComposerDraftStore.shared.setSending(session, true)
        let delivery = onSend(payload)
        Task { @MainActor in
            let delivered = await delivery.value
            ComposerDraftStore.shared.setSending(session, false)
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
        panel.allowedContentTypes = [.image, .movie, .pdf, .plainText]
        guard panel.runModal() == .OK else { return }
        attach(panel.urls)
    }

    /// A dropped provider is a file, a video with no file of its own yet, picture bytes, or something conch can't
    /// attach, which the composer says rather than dropping.
    ///
    /// Asked by CONFORMANCE rather than by coercing `public.image`: a provider registers the
    /// concrete type it actually holds (`public.png`), and asking it for the abstract parent
    /// is not guaranteed to transcode.
    private func load(_ providers: [NSItemProvider]) {
        let session = sessionID
        let videos = ComposerVideos.shared
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    // A promised file can arrive as a URL that is not written yet; attaching a
                    // path with nothing behind it would fail later, at send. Said, not dropped.
                    guard let url, FileManager.default.fileExists(atPath: url.path) else {
                        let name = url?.lastPathComponent ?? "A file"
                        Task { @MainActor in videos.refused(name, to: session, because: "conch couldn't find it") }
                        return
                    }
                    Task { @MainActor in attach([url]) }
                }
                continue
            }
            // A screen recording's thumbnail, a video from Photos or a browser: promised, or bytes. Asked for before a
            // picture, so a video that also carries a still of itself goes as the video.
            if let movie = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .movie) == true }) {
                receive(movie, from: provider)
                continue
            }
            guard let type = provider.registeredTypeIdentifiers.first(where: {
                UTType($0)?.conforms(to: .image) == true
            }) else {
                videos.refused(provider.suggestedName ?? "That", to: session, because: "conch attaches files, pictures and videos")
                continue
            }
            let name = provider.suggestedName ?? "A picture"
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                guard let data, let image = NSImage(data: data),
                      let url = ComposerPasteBridge.temporaryPNG(image, prefix: "conch-drop") else {
                    Task { @MainActor in videos.refused(name, to: session, because: "conch couldn't read it") }
                    return
                }
                Task { @MainActor in attach([url]) }
            }
        }
    }

    /// A video without a file of its own: promised by its source, which writes it once the drop is taken (a screen
    /// recording's thumbnail, Photos, which may fetch it from iCloud first), or handed over as bytes. It is kept where
    /// conch keeps such files (`ComposerDropFolder`), under the name it had, and attached as a file is. Its tile says it
    /// is on its way; one that never arrives says so, after five minutes.
    private func receive(_ type: String, from provider: NSItemProvider) {
        let session = sessionID
        let videos = ComposerVideos.shared
        let suggested = provider.suggestedName
        let arrival = videos.arriving(suggested ?? "A video", to: session)
        let progress = provider.loadFileRepresentation(forTypeIdentifier: type) { file, error in
            // The provider's file goes once this returns: copied out first.
            let kept = Result { () throws -> URL in
                guard let file else { throw error ?? CocoaError(.fileReadUnknown) }
                return try ComposerDropFolder.keep(file, named: suggested, type: UTType(type))
            }
            Task { @MainActor in
                switch kept {
                case let .success(url):
                    videos.arrived(arrival, to: session)
                    attach([url])
                case let .failure(failure):
                    NSLog("conch: a dropped video didn't arrive: %@", failure.localizedDescription)
                    videos.arrived(arrival, to: session, failure: "It never arrived")
                }
            }
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(300))
            guard videos.arrivals[session]?.contains(where: { $0.id == arrival && $0.failure == nil }) == true else { return }
            progress.cancel()
            videos.arrived(arrival, to: session, failure: "It never arrived")
        }
    }

    /// The one rule for adding attachments, whether dropped, pasted or picked:
    /// no duplicates, and the first one claims the draft for this session.
    private func attach(_ urls: [URL]) {
        let fresh = urls.filter { !attachments.contains($0) }
        guard !fresh.isEmpty else { return }
        let wasEmpty = attachments.isEmpty
        attachments.append(contentsOf: fresh)
        // A video is made ready for the agent from the moment it is attached, so one that can't be read says so on its
        // tile before anything is sent.
        for url in fresh where VideoAttachment.isVideo(url) { ComposerVideos.shared.prepare(url, again: true) }
        if wasEmpty { onDraftStarted() }
    }
}

/// The composer's card under the conversation.
private struct ComposerCard: ViewModifier {
    let isTargetedForDrop: Bool

    func body(content: Content) -> some View {
        content
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
            .overlay { dropRing(radius: ConchRadius.large) }
            // The token rather than a hand-rolled shadow: §3 names this elevation, and a literal
            // that happens to look right is how the design system and the app come apart.
            .conchElevation(.floating)
            .frame(maxWidth: ConversationTextView.composerMeasure)
            .padding(.horizontal, 16)
            .padding(.bottom, 14)
    }

    /// `.cbox.drop{box-shadow:0 0 0 2px #0A84FF,var(--shFloat)}` — 2 pt, the system drop
    /// blue, on the CARD. It was a 1.5 pt cyan rect at radius 8, drawn after the card's
    /// own 16 pt padding, so it floated off the edge at the wrong corner radius and in the
    /// colour this app uses for the microphone. Tyler: "process was kinda weird, and idk
    /// if it worked or not" — a drop target has one job, which is to say "here".
    @ViewBuilder
    private func dropRing(radius: CGFloat) -> some View {
        if isTargetedForDrop {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(ConchPalette.dropTarget, lineWidth: 2)
        }
    }
}

/// The one composer for a session, wired to the store, under the conversation in conch's window.
struct SessionComposer: View {
    let row: SessionRow
    let state: PublishedState?
    let store: StateStore
    var focusRequest = 0
    /// The first character or file: a claim on this session, so whatever shows it stops following the busiest session.
    let onDraftStarted: () -> Void
    /// One draft per session wherever it is typed.
    @ObservedObject private var composerDrafts = ComposerDraftStore.shared

    /// What the mic is doing FOR THIS ROW, by identity (`WorkspaceModel.voiceState`): a row the voice is not on reports
    /// nothing, or every composer would mirror the same words.
    private func voiceState(for row: SessionRow) -> String {
        WorkspaceModel.voiceState(of: row, in: state)
    }

    var body: some View {
        ComposerView(
            sessionID: row.id,
            sessionLabel: row.label,
            backend: row.backend,
            draft: composerDrafts.textBinding(for: row.id),
            attachments: composerDrafts.attachmentsBinding(for: row.id),
            // Everything said so far, after the draft, for this row only (`ComposerDraftStore.dictationPreview`).
            dictation: composerDrafts.dictationPreview(for: row.id, live: WorkspaceModel.dictation(of: row, in: state)),
            isWorking: row.status == .working,
            voiceState: voiceState(for: row),
            voiceLevel: WorkspaceModel.voiceLevel(of: row, in: state),
            audioHeldElsewhere: state?.audioControl.isLocal == false,
            noTerminal: row.noTerminal,
            messageRoute: row.messageRoute,
            onOpenInTerminal: row.attachable ? { store.openInTerminal(row) } : nil,
            // The agent's commands as they are typed, where they can be typed: ⌘K's rule, a session's own pane conch can
            // reach, and a terminal to type into.
            commandCapabilities: row.parentSessionId == nil && row.revealable && row.noTerminal == nil
                ? { await store.capabilities(backend: row.backend ?? "claude", cwd: "", sessionId: row.id).capabilities }
                : nil,
            onSend: { text in
                store.send(.inject(sessionId: row.id, label: row.label, text: text))
            },
            onInterrupt: {
                store.send(.interrupt(sessionId: row.id, label: row.label))
            },
            onTalk: {
                // The same button both ways. It showed a live waveform and
                // still only ever OPENED the mic, so the one control that
                // looks like it is running had no way to stop the thing it
                // was showing — you had to find the spacebar, which a text
                // field now swallows anyway.
                if LiveState.isExchangeActive(voiceState(for: row)) {
                    store.send(.stop())
                } else {
                    // The mic BESIDE a text field fills that field. It used to
                    // send the spoken half straight past the composer into the
                    // session, so what you typed and what you said could not be
                    // one message. Noted first, so the field shows the words
                    // joining the draft as they are spoken (2026-10-05).
                    composerDrafts.requestDictation(for: row.id)
                    store.send(.dictate(sessionId: row.id, label: row.label))
                }
            },
            onRecite: {
                store.send(.recite(sessionId: row.id, label: row.label))
            },
            onDraftStarted: onDraftStarted,
            focusRequest: focusRequest
        )
    }
}

/// Attached images preview as images, and videos as their first frame; other supported files keep the compact
/// filename treatment. The path remains available as hover help for each. After them, drops still on their way and
/// those that never arrived, each saying so.
private struct AttachmentStrip: View {
    let attachments: [URL]
    var arrivals: [ComposerVideos.Arrival] = []
    let onRemove: (URL) -> Void
    var onDismiss: (UUID) -> Void = { _ in }
    @Environment(\.conchRendersStatically) private var rendersStatically

    var body: some View {
        // `#cAtt{display:flex;gap:6px;padding:6px 6px 2px}`. The strip was capped at
        // `maxHeight: 48` around tiles the lab draws 52 tall, so every attachment was
        // clipped by its own container.
        Group {
            if rendersStatically {
                // A picture can't draw a scroll view: the tiles as they sit at its start.
                tiles.fixedSize().frame(maxWidth: .infinity, alignment: .leading).clipped()
            } else {
                ScrollView(.horizontal, showsIndicators: false) { tiles }
            }
        }
        .padding(.top, 6)
        .padding(.horizontal, 6)
        .padding(.bottom, 2)
    }

    private var tiles: some View {
        HStack(spacing: 6) {
            ForEach(attachments, id: \.self) { url in
                AttachmentPreview(url: url) { onRemove(url) }
            }
            ForEach(arrivals) { arrival in
                ArrivalTile(arrival: arrival) { onDismiss(arrival.id) }
            }
        }
    }
}

private struct AttachmentPreview: View {
    let url: URL
    let onRemove: () -> Void

    /// A video is never decoded as a picture: `NSImage(contentsOf:)` reads the whole file to learn what it is, and this
    /// runs every time the strip draws. A 95 MB screen recording measured 199 MB resident for one call, on the main
    /// thread; a long recording is gigabytes.
    private var isVideo: Bool { VideoAttachment.isVideo(url) }
    private var image: NSImage? { isVideo ? nil : NSImage(contentsOf: url) }

    @ViewBuilder
    var body: some View {
        if isVideo {
            VideoTile(url: url, remove: removeButton)
        } else if let image {
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

    private var removeButton: some View {
        AttachmentRemoveButton(name: url.lastPathComponent, action: onRemove)
    }
}

/// `.att .x{width:18px;height:18px;border-radius:50%;background:rgba(29,29,31,.62);
/// color:#fff}` — it was 14x14 on the window ground at 88%, which on a pale screenshot
/// was a grey dot on a grey picture.
private struct AttachmentRemoveButton: View {
    let name: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(Circle().fill(Color(red: 0.114, green: 0.114, blue: 0.122).opacity(0.62)))
        }
        .buttonStyle(.plain)
        .help("Remove \(name)")
    }
}

/// A video's tile: its first frame at a picture's size (`.att.img`), how long it is on it, and while it is made ready
/// for the agent a spinner there instead. One that can't go is a file's chip saying why (`AttachmentNotice`).
private struct VideoTile<Remove: View>: View {
    let url: URL
    let remove: Remove
    @ObservedObject private var videos = ComposerVideos.shared
    @State private var poster: NSImage?

    private var status: VideoAttachment.Status? { videos.status(of: url) }

    var body: some View {
        Group {
            if case let .failed(reason)? = status {
                AttachmentNotice(name: url.lastPathComponent, detail: reason, failed: true) { remove }
                    .help("\(url.path)\n\(reason)")
            } else {
                ZStack(alignment: .topTrailing) {
                    ZStack(alignment: .bottomLeading) {
                        picture
                        badge.padding(4)
                    }
                    .frame(width: 68, height: 52)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .strokeBorder(ConchPalette.hairlineStrong, lineWidth: 0.5)
                    }

                    remove
                        .padding(4)
                }
                .help(help)
            }
        }
        // A draft's video after a relaunch is made ready again here; one just attached already is (`attach`).
        .task(id: url) {
            videos.prepare(url)
            poster = await ComposerVideoPrep.poster(of: url)
        }
    }

    @ViewBuilder
    private var picture: some View {
        if let poster {
            Image(nsImage: poster)
                .resizable()
                .scaledToFill()
                .frame(width: 68, height: 52)
        } else {
            ConchPalette.fill
        }
    }

    /// Its length on a dark pill, the remove button's ink; a spinner while it is made ready.
    private var badge: some View {
        HStack(spacing: 3) {
            if case let .ready(brief)? = status {
                Image(systemName: "play.fill")
                    .font(.system(size: 7, weight: .bold))
                Text(CanvasStoryboard.clock(brief.length))
                    .font(.system(size: 9.5, weight: .semibold))
                    .monospacedDigit()
            } else {
                // Light on the dark pill, in either appearance.
                ProgressView()
                    .controlSize(.mini)
                    .environment(\.colorScheme, .dark)
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 5)
        .frame(height: 15)
        .background(Capsule().fill(Color(red: 0.114, green: 0.114, blue: 0.122).opacity(0.62)))
    }

    private var help: String {
        switch status {
        case let .ready(brief)?:
            let frames = "\(brief.frames.count) frame\(brief.frames.count == 1 ? "" : "s")"
            let read = VideoStoryboard.isCut(brief.length) ? " The agent reads its \(VideoAttachment.caption(length: brief.length))." : ""
            return "\(url.path)\nGoes as a contact sheet of \(frames)\(brief.said.isEmpty ? "" : " and what was said, timed").\(read)"
        default:
            return "\(url.path)\nGetting it ready for the agent: its frames and what was said"
        }
    }
}

/// A drop on its way (a promised video being written), or one that never arrived, in the file chip's shape.
private struct ArrivalTile: View {
    let arrival: ComposerVideos.Arrival
    let onDismiss: () -> Void

    var body: some View {
        if let failure = arrival.failure {
            AttachmentNotice(name: arrival.name, detail: failure, failed: true) {
                AttachmentRemoveButton(name: arrival.name, action: onDismiss)
            }
            .help("\(arrival.name): \(failure)")
        } else {
            AttachmentNotice(name: arrival.name, detail: "Arriving…", failed: false) { EmptyView() }
                .help("\(arrival.name) is being handed over")
        }
    }
}

/// The file chip (`.att.fl`) with a second line: what is happening to it, or, failed, why it can't go, in the colour
/// that asks for attention.
private struct AttachmentNotice<Trailing: View>: View {
    let name: String
    let detail: String
    let failed: Bool
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 8) {
            if failed {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(ConchPalette.statusNeeds)
            } else {
                ProgressView()
                    .controlSize(.mini)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(ConchTypography.font(size: 12.5))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(detail)
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(failed ? ConchPalette.statusNeeds : ConchPalette.textFaint)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
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
        .overlay(alignment: .trailing) { trailing().padding(.trailing, 4) }
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
              let url = temporaryPNG(image, prefix: "conch-paste") else { return [] }
        return [url]
    }

    /// Image bytes as a file something can attach.
    ///
    /// Shared with the drop path: both arrive holding pixels and no file, and writing that out
    /// twice is how the two come to disagree about format or naming. The prefix says which
    /// door it came through, which is the only thing a temp file can tell you afterwards.
    static func temporaryPNG(_ image: NSImage, prefix: String) -> URL? {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString).png")
        do { try png.write(to: url) } catch { return nil }
        return url
    }
}
