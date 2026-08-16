# Conch user-interface audit: macOS, iPhone, and terminal

Audit date: 2026-08-12  
Scope: `mac-app/conch-mac/`, `mobile/conch-ios/conch-ios/`, and the terminal theater/footer and their input/action paths.  
Method: bottom-up source audit of all authored UI, state, transport, lifecycle, settings, and focused tests that determine a user-visible action. Line citations describe the action that actually runs, not the label. Generated build trees, binaries, module caches, and bitmap pixels were inventoried and excluded from semantic reading. No product code was changed.

## Bottom line

The three surfaces are not three presentations of one interaction model. They currently implement materially different products:

- The Mac mic sends `wake`/`stop` to the daemon's Mac microphone. The iPhone mic starts/stops local speech recognition and **never sends**; Send is separate. The TUI Space key wakes/stops the daemon microphone, but only in theater mode (`mac-app/conch-mac/DashboardView.swift:1548-1558`; `mobile/conch-ios/conch-ios/SessionView.swift:599-612`; `src/daemon.ts:5231-5236`).
- iPhone typing and dictation share one persisted, per-session draft. Mac dictation is displayed beside—not merged into—the typed draft, and the composer is not keyed per session. Terminal has no text draft (`mobile/conch-ios/conch-ios/TalkController.swift:140-180`; `mac-app/conch-mac/ComposerView.swift:173-203`; `mac-app/conch-mac/DashboardView.swift:1535-1568`).
- “Manual” on Mac/iPhone means pause/hold. The TUI still exposes both pause (hold/replay) and mute (forget), and Mac still has a live hidden `M` mute path despite a comment that mute was retired (`src/instant-controls.ts:54-78,92-156`; `mac-app/conch-mac/DashboardView.swift:373-378`; `mac-app/conch-mac/ContentView.swift:246-260`).
- Backgrounding the iPhone calls `stop()` on its transport; foregrounding calls only `reconnectNow()`, but both transport implementations reject reconnect after stop. The first background therefore permanently disconnects that cached client until unpair/relaunch (`mobile/conch-ios/conch-ios/ConchApp.swift:74-130`; `mobile/conch-ios/conch-ios/DirectHTTPTransport.swift:33-60`; `mobile/conch-ios/conch-ios/RelayTransport.swift:276-302`).
- Footer mode paints a keyboard bar while intentionally disabling input dispatch. stdin is still raw, so every advertised key—including `q` and Ctrl-C—is swallowed (`src/status.ts:1208-1214`; `src/daemon.ts:5186-5195`; `src/theater-controls.ts:44-45`).
- Dismiss/restore is complete on Mac, dismiss-only in theater, and absent on iPhone. Terminal restore code exists but no key/menu can reach it; iPhone drops `dismissedRows` while decoding (`mac-app/conch-mac/ContentView.swift:185-194`; `src/session-actions-overlay.ts:70-82`; `src/daemon.ts:1125-1141`; `mobile/conch-ios/conch-ios/Models.swift:147-170`).
- Mac can render/reveal/open artifacts, iPhone can preview a subset, and TUI never consumes the stored artifact link (`mac-app/conch-mac/ReviewView.swift:187-305`; `mobile/conch-ios/conch-ios/DeliverableSheet.swift:23-147`; `src/panel.ts:31-45`; `src/status.ts:421-433`).

The highest-risk failures are the iPhone post-background dead connection, possible background mic reopening, invisible off-screen iPhone recording, Mac draft loss on an unacknowledged send, image-only iPhone Send doing nothing, inert question-option affordances, the dead footer keybar, and the still-live destructive mute paths.

## Part 1 — exhaustive control inventory

### 1A. macOS app

#### Application, pairing, daemon, and header

| Control | Where, states, and appearance | Actual action |
|---|---|---|
| Dock/app activation and reopen | App launches a dashboard window; clicking Dock/open with no visible window creates or fronts it. | Starts/adopts the daemon at launch, probes on activation, stops the daemon on app termination, and reopens/fronts the window (`mac-app/conch-mac/ConchMacApp.swift:19-32,78-115`). |
| App menu **Keyboard Shortcuts** | Conch app menu item; no menu-key equivalent declared. | Posts `showKeyboardShortcuts`, which presents the dashboard sheet (`mac-app/conch-mac/ConchMacApp.swift:36-46`; `mac-app/conch-mac/ContentView.swift:124-130`). |
| Settings scene / `⌘,` | Native Settings window with Phone app and Settings tabs. | Opens the respective SwiftUI settings scenes; the shortcut sheet merely documents `⌘,` (`mac-app/conch-mac/ConchMacApp.swift:48-66`; `mac-app/conch-mac/ContentView.swift:343-345`). |
| **New code** | Phone app pairing view; enabled normally, QR/code change after success/failure. | Forces the pairing store to open a new code request (`mac-app/conch-mac/PairingView.swift:49-60,194-223`). The QR and text are display/copy-selectable content, not connect controls. |
| Pairing QR/code/expiry | Relay QR or LAN hosts plus code; display-only. | No Copy button. Expiry is computed on render with no timer, so the countdown can remain stale until unrelated state changes (`mac-app/conch-mac/PairingView.swift:82-172`). |
| **Start** | Daemon-trouble empty state. | Calls `daemon.start` (`mac-app/conch-mac/DashboardView.swift:211-234`). |
| **Relaunch** | Newer/stale build warning. | Calls `store.relaunchForNewBuild` (`mac-app/conch-mac/DashboardView.swift:188-209`). |
| Warning close `×` | Dismissible top warning. | Calls `onDismissNewerDaemonWarning`; it hides the warning, not the underlying daemon condition (`mac-app/conch-mac/DashboardView.swift:429-451`). |
| Plugin hint **Copy command / Copied** | Plugin education banner. Copy turns green/changes label after click. | Clears the general pasteboard and writes the fixed marketplace command (`mac-app/conch-mac/DashboardView.swift:297-327`). |
| Plugin hint `×` | Same banner. | Persists the hint dismissal in UserDefaults (`mac-app/conch-mac/DashboardView.swift:329-338`; `mac-app/conch-mac/StateStore.swift:629-632`). |
| Auto / Manual / Muted mode button | Header. Auto = cyan waveform + “Auto”; Manual = dim raised hand + “Manual”; Muted = red speaker slash + “Muted.” Help explains scope and, for mute, that turns are forgotten (`mac-app/conch-mac/DashboardView.swift:2510-2559`). | If currently muted, sends unmute. Otherwise toggles pause/resume for selected session or globally; under global pause, a selected session gets a scoped resume exemption (`mac-app/conch-mac/DashboardView.swift:359-378,490-512`; `mac-app/conch-mac/ContentView.swift:227-243,246-260`). |
| Settings gear | Header button, hover fill and help. | Calls `openSettings` (`mac-app/conch-mac/DashboardView.swift:513-517`). |
| Logs button | Header button, selected state while logs shown. | Toggles the dashboard log pane (`mac-app/conch-mac/DashboardView.swift:518-523`; `mac-app/conch-mac/ContentView.swift:79-106`). |
| `?` button | Header question-mark button. | Presents the shortcut sheet (`mac-app/conch-mac/DashboardView.swift:524-528`; `mac-app/conch-mac/ContentView.swift:304-324`). |
| **Close** / Esc in shortcut sheet | Pinned sheet footer, plus native close. | Dismisses the sheet; `.cancelAction` and `onExitCommand` both map Esc to dismiss (`mac-app/conch-mac/ContentView.swift:355-380`). |

#### Session ledger

| Control | Where, states, and appearance | Actual action |
|---|---|---|
| **All sessions** row | First row; selected when no explicit session, hover/selected fill, live count. Tooltip still says “pause, mute and talk apply to all.” | Clears explicit selection (`mac-app/conch-mac/DashboardView.swift:597-612,2470-2507`). It is the visible replacement for Esc and changes the scope of header mode/talk actions. |
| Session row click | Status-sorted ledger. Selected/hover/live backgrounds; paused/muted labels dim. Glyph/state priority is review/wait/need before muted/paused, so urgent status stays visible (`mac-app/conch-mac/DashboardView.swift:614-631,758-827,1115-1282`). | Sets `selectedSessionID` (`mac-app/conch-mac/ContentView.swift:163-165`). |
| Session row right-click **Rename** | Context menu on live row. | Starts inline rename for that row (`mac-app/conch-mac/DashboardView.swift:785-816`; `mac-app/conch-mac/ContentView.swift:167-178`). |
| Inline rename field | Replaces label; editable focus; Return commits, Esc cancels. | Commit sends session rename; cancel restores normal row. Empty/invalid validation follows the session command response (`mac-app/conch-mac/DashboardView.swift:855-870`; `mac-app/conch-mac/ContentView.swift:167-178`). |
| Session row right-click **Dismiss** | Context menu item, no confirmation. | Optimistically hides the row, opens a six-second undo window, and sends dismiss (`mac-app/conch-mac/ContentView.swift:185-190`; `mac-app/conch-mac/StateStore.swift:160-177,478-491`). Daemon dismissal also cancels speech/previews, releases TUI selection, and session-mutes/forgets while the agent keeps running (`src/daemon.ts:4544-4560`). |
| Dismissed row **Undo** | Dim/grayscale row under Dismissed divider; visible only during six-second local undo window. | Sends restore for that dismissed id (`mac-app/conch-mac/DashboardView.swift:1035-1087`; `mac-app/conch-mac/ContentView.swift:192-194`). |
| Dismissed row right-click **Restore** | Context menu on every published dismissed row. | Sends restore, clearing dismissed and muted state (`mac-app/conch-mac/DashboardView.swift:1081-1084`; `src/daemon.ts:1133-1141`). |
| `↑` / `↓` | Dashboard key monitor, repeat allowed. | Moves explicit selection through current rows; moving beyond either edge clears selection (`mac-app/conch-mac/DashboardInputMonitor.swift:57-59,125-145`; `mac-app/conch-mac/ContentView.swift:272-290`). |
| Esc | Dashboard key monitor. | Cancels rename first, otherwise releases selection (`mac-app/conch-mac/ContentView.swift:292-298`). |

Ledger appearance also includes a read-only priority diamond and published per-session voice; Mac has no action to change either. Its socket/UI session actions expose rename, dismiss, and restore only (`mac-app/conch-mac/ConchSocketClient.swift:85-106`; `mac-app/conch-mac/SettingsView.swift:118-173`).

#### Deliverable, conversation, and composer

| Control | Where, states, and appearance | Actual action |
|---|---|---|
| **Deliverable / Conversation** segmented choices | Above the persistent composer; selected option has raised fill, hover state, icon and label. | Switches only the pane perspective; it does not fetch or change session state (`mac-app/conch-mac/DashboardView.swift:1504-1519,1627-1658`). |
| Review expand/collapse | Arrow icon in review caption. Expand is absent when review has no link; collapse has Esc shortcut. | Changes inline review to full-window content and back (`mac-app/conch-mac/ReviewView.swift:31-61,113-148`). |
| Web **Open in browser** | Origin bar above embedded web artifact. | Opens the link through `NSWorkspace` (`mac-app/conch-mac/ReviewView.swift:284-305`). |
| Unsupported local **Reveal in Finder** | Unsupported file/folder fallback; path is selectable. | Calls `activateFileViewerSelecting` on that URL (`mac-app/conch-mac/ReviewView.swift:216-254`). |
| Web failure **Retry** | Only when failure is retryable. | Clears failure and changes reload id, causing WebKit reload (`mac-app/conch-mac/ReviewView.swift:369-418,456-461`). |
| Web failure **Back to Review** | Nonretryable failure. | Dismisses the failure overlay only (`mac-app/conch-mac/ReviewView.swift:419-433`). |
| Web failure **Open in Browser** | Only when failure marks URL externally openable. | Opens failed URL through `NSWorkspace` (`mac-app/conch-mac/ReviewView.swift:434-451`). |
| Conversation tool row | Glyph/name/detail; chevron only for nonempty result. | Toggles that result inline; an empty-result row returns without action (`mac-app/conch-mac/ConversationStackView.swift:113-166`). |
| File-change row | File name, `+`/`−` counts, chevron, truncated note. | Toggles the published added/removed excerpt; never opens the file or full diff (`mac-app/conch-mac/ConversationStackView.swift:297-356`). |
| Attach `+` | Composer left. | Opens multi-file picker for images, PDF, and plain text (`mac-app/conch-mac/ComposerView.swift:57-64,365-372`). |
| File drop target | Entire composer; border/highlight while targeted. | Accepts every `fileURL` provider and appends its path; unlike picker, it does not validate type (`mac-app/conch-mac/ComposerView.swift:158-170,374-383`). |
| Attachment `×` | Each attachment chip. | Removes that pending path (`mac-app/conch-mac/ComposerView.swift:390-418`). |
| Composer TextEditor | Multiline draft; focus disables dashboard key monitor. Dictation appears in the editor presentation but is not written into `draft`. | Edits view-local `@State draft`; first nonempty edit pins/selects current row (`mac-app/conch-mac/ComposerView.swift:41-43,173-203`). Return sends; Shift-Return is left to insert newline (`mac-app/conch-mac/ComposerView.swift:210-219`). |
| Mic button | Idle mic; listening/recording waveform; transcribing ellipsis; speaking speaker. Cyan/red/dim backgrounds and contextual tooltips (`mac-app/conch-mac/ComposerView.swift:72-101,247-304`). | When the focused row is idle, sends targeted daemon `wake`; whenever its voice state is nonidle, sends global `stop` (`mac-app/conch-mac/DashboardView.swift:1548-1558`). It uses the Mac/daemon microphone—not local per-composer recognition. |
| Recite speaker | Dim speaker, disabled without usable target/reply. | Sends targeted daemon `recite` (`mac-app/conch-mac/ComposerView.swift:103-115`; `mac-app/conch-mac/DashboardView.swift:1560-1562`). |
| Amber Stop | Appears only while row is working **and** composed text is empty. | Sends targeted interrupt (`mac-app/conch-mac/ComposerView.swift:123-132`; `mac-app/conch-mac/DashboardView.swift:1545-1547`). Any typed text or attachment replaces it with Send. |
| Send / Return | Up arrow, enabled when composed text or attachment paths exist; Return has no modifiers. | Injects attachment paths followed by typed text, then immediately clears draft and attachments regardless of socket acknowledgement (`mac-app/conch-mac/ComposerView.swift:134-149,343-363`; `mac-app/conch-mac/StateStore.swift:116-130`). |
| Space | Dashboard key. | If any live exchange exists, sends global stop; otherwise wakes selected/fallback session (`mac-app/conch-mac/ContentView.swift:196-208`). |
| `R` | Dashboard key. | Recites selected/fallback row (`mac-app/conch-mac/ContentView.swift:262-269,304-324`). |
| `P` | Dashboard key. | Same pause/resume scoping as header Manual control (`mac-app/conch-mac/ContentView.swift:227-243,304-324`). |
| `M` | Dashboard key, still documented. | Same separate mute/unmute scoping as the retired mute implementation (`mac-app/conch-mac/ContentView.swift:246-260,304-324,336-346`). |
| `?` | Dashboard key. | Opens shortcut sheet (`mac-app/conch-mac/DashboardInputMonitor.swift:119-121`; `mac-app/conch-mac/ContentView.swift:304-324`). |

Native artifact controls are type-specific: image/PDF/text use their native scrolling, zooming, selection, and PDF viewer controls; AVPlayer supplies video transport and unmute controls; WebKit enables back/forward swipe and magnification. Cross-origin top-level web navigation is confirmed before leaving the embedded origin (`mac-app/conch-mac/ReviewView.swift:187-258,617-642`; `mac-app/conch-mac/WebView.swift:94-133,170-229,260-274`). Missing local files are passive error copy with no Finder/retry action (`mac-app/conch-mac/ReviewView.swift:259-283`).

**Editable-focus reachability defect.** The monitor returns the event immediately whenever the first responder is an editable `NSTextView`, `NSTextField`, or field editor (`mac-app/conch-mac/DashboardInputMonitor.swift:46-52,79-93`). With the composer focused, Space, `P`, `M`, `R`, `?`, arrows, and Esc all go to the editor or nowhere. Replacements are: mic/Stop for Space; header mode for `P`; speaker for `R`; `?` header button; row clicks for arrows; All sessions for Esc. **`M` has no replacement while the mode is not already muted.** Only after another path has muted the scope does the header change to “Muted” and become an unmute control (`mac-app/conch-mac/DashboardView.swift:490-512,2519-2559`). The shortcut sheet nevertheless advertises all of them without this focus qualification (`mac-app/conch-mac/ContentView.swift:336-346`).

#### Mac settings controls

The settings registry supplies 26 rows; the Mac renders all of them. Environment-sourced rows are disabled and explain why; pending rows show a spinner. A nondefault file value gets a reset-arrow button that sends unset/reset (`mac-app/conch-mac/SettingsView.swift:254-344`).

| Kind/control | Actual action and states |
|---|---|
| Boolean switch | Sends new boolean immediately; invalid booleans show an inert “Invalid boolean value” fallback (`mac-app/conch-mac/SettingsView.swift:375-394`). |
| Enum menu | Sends selected published choice; absent choices show inert error (`mac-app/conch-mac/SettingsView.swift:395-413`). |
| Number/integer field | Enter, blur, temporary **Apply**, or Stepper commits a validated value; integer step 1, number step derived from metadata (`mac-app/conch-mac/SettingsView.swift:420-510`). |
| Reset arrow | Unsets a file override and returns to environment/default, disabled while pending (`mac-app/conch-mac/SettingsView.swift:303-323`). |
| **Try Again** | Refetches when no settings/feedback is available (`mac-app/conch-mac/SettingsView.swift:176-194`). |
| **Refresh** | Refetches the complete descriptor/value/source registry; disabled and accompanied by spinner while refreshing (`mac-app/conch-mac/SettingsView.swift:37-66`). |
| Daemon power switch | Starts/stops an app-owned daemon. An adopted daemon instead shows inert “started elsewhere” and cannot be stopped here (`mac-app/conch-mac/SettingsView.swift:568-633`; `mac-app/conch-mac/DaemonHost.swift:106-125`). |
| Session voices list | Read-only label/voice rows loaded once from the snapshot; no set/reset control, and copy directs the user to CLI/voice command (`mac-app/conch-mac/SettingsView.swift:118-173`). |
| String row | **Unreachable as a control.** The kind switch falls to “Unsupported kind: string,” so `phone-relay-url` cannot be edited on Mac (`mac-app/conch-mac/SettingsView.swift:375-416`; `src/settings.ts:300-309`). |

Other Mac controls implemented but unreachable: `KeybarActionButton` has no call site (`mac-app/conch-mac/DashboardView.swift:2349-2404`); `noteBar` is defined but unused (`mac-app/conch-mac/DashboardView.swift:1608-1624`); `DaemonHost.restart()` has no UI/caller (`mac-app/conch-mac/DaemonHost.swift:127-130`); `splitAtUTF16Offset` is dead (`mac-app/conch-mac/DashboardView.swift:2452-2468`); and `ComposerView.sessionID` does not scope its state. The app contains no swipe actions, long-press controls, or draggable sources beyond the file drop target.

Closing the Mac window is not quitting: Dock/open raises or recreates it. Quitting stops only a daemon the app owns; an adopted CLI/launchd daemon is deliberately left running (`mac-app/conch-mac/ConchMacApp.swift:69-115`; `mac-app/conch-mac/DaemonHost.swift:106-125`).

### 1B. iPhone app

#### Pairing and ledger

| Control | Where, states, and appearance | Actual action |
|---|---|---|
| Host field | LAN pairing form; monospaced, auto-focused, hidden as soon as code starts with relay prefix. | Edits local `host`; no validation/network action while typing (`mobile/conch-ios/conch-ios/PairingView.swift:78-103,209-228`). |
| Code field | Six-digit/long-token/relay input; relay prefix alone hides Host. | Edits local `code`; keyboard Return has no `.onSubmit` and does not connect (`mobile/conch-ios/conch-ios/PairingView.swift:17-42,209-228`). |
| **Scan relay QR** | QR glyph button opens a full-sheet camera preview. Native swipe-down is the only cancel. | Accepts only relay-prefixed QR, fills code, dismisses, and auto-connects. Camera/input/output failure silently leaves a blank sheet; no torch/error/settings control (`mobile/conch-ios/conch-ios/PairingView.swift:105-113,149-164,248-294`). |
| **Use this network instead** | Relay-confirmation state. | Clears only `code`, restoring LAN fields; it does not cancel an in-flight task (`mobile/conch-ios/conch-ios/PairingView.swift:78-94`). |
| **Connect / Checking…** | Full-width; disabled/dim until syntactically pairable; spinner label while checking. | Relay payload is decoded; six digits POST `/pair`; long token probes `/state`. Success stores pairing and starts bridge; failure shows inline red copy (`mobile/conch-ios/conch-ios/PairingView.swift:124-205`; `mobile/conch-ios/conch-ios/BridgeClient.swift:369-415`). Keychain save result is ignored (`mobile/conch-ios/conch-ios/BridgeClient.swift:478-487`). |
| Session row | NavigationLink; status glyph, label, optional detail/review, age and state word; 55% opacity disconnected, 72% paused/muted. | Pushes that id's SessionView (`mobile/conch-ios/conch-ios/LedgerView.swift:49-61,257-309`). Native Back and edge-swipe pop it. No swipe actions/context menu/long press/dismiss/rename. |
| Auto/manual icon | Toolbar waveform (cyan) or raised hand (dim); only accessibility says Auto/Manual. Optimistic up to 3s, not disabled offline. | Sends global daemon pause/resume; switching to manual stops phone speech **after** awaiting network (`mobile/conch-ios/conch-ios/LedgerView.swift:159-213`). It reads only `paused`, not `muted`. |
| Laptop/connection menu | Laptop, dim/red slash offline; label includes host. | Opens menu; status/build rows are informational (`mobile/conch-ios/conch-ios/LedgerView.swift:84-122`). |
| **Reconnect now** | Always in laptop menu. | Calls `bridge.reconnectNow()` (`mobile/conch-ios/conch-ios/LedgerView.swift:102`; `mobile/conch-ios/conch-ios/BridgeClient.swift:140-144`). It cannot revive a client stopped by backgrounding. |
| **Stop reading** | Menu item only while the shared phone synthesizer speaks. | Stops all phone TTS and releases its audio session (`mobile/conch-ios/conch-ios/LedgerView.swift:104-107`; `mobile/conch-ios/conch-ios/SpeechController.swift:154-173`). |
| **conch settings…** | Menu item. | Presents Settings sheet (`mobile/conch-ios/conch-ios/LedgerView.swift:108,130-132`). |
| **Unpair from this Mac…** then confirmation **Unpair** | Red menu item and native confirmation dialog; native Cancel. | Stops client, deletes Keychain credentials, clears cache, and returns to pairing (`mobile/conch-ios/conch-ios/LedgerView.swift:110-141`; `mobile/conch-ios/conch-ios/ConchApp.swift:168-173`). |
| Empty/stale ledger | “Nothing running yet” or reconnecting banner; no inline button. | Informational. Retry is hidden in laptop menu (`mobile/conch-ios/conch-ios/LedgerView.swift:34-56,216-254`). |

#### Session, conversation, composer, and artifact

| Control | Where, states, and appearance | Actual action |
|---|---|---|
| Back / edge swipe | Native navigation. | Pops the view and clears only `onFinishedReading`; **does not close app-owned mic**, so capture can continue invisibly on ledger (`mobile/conch-ios/conch-ios/SessionView.swift:230-241`; `mobile/conch-ios/conch-ios/ConchApp.swift:17-27`). |
| Review card **View the work** | Gold card; disabled if link absent. | Presents DeliverableSheet (`mobile/conch-ios/conch-ios/SessionView.swift:87-91,225-229,670-698`). |
| Speaker / red Stop | Toolbar. Disabled without separate `replyText` or while this session owns mic. Red stop whenever any session is speaking. | Starts local AVSpeech for current `replyText`, or stops global phone TTS (`mobile/conch-ios/conch-ios/SessionView.swift:142-161`; `mobile/conch-ios/conch-ios/SpeechController.swift:98-120,154-173`). Visible conversation items alone are insufficient. |
| **Mic open** chip | Toolbar only when this session owns capture. | Banks live partial and closes local capture without sending (`mobile/conch-ios/conch-ios/SessionView.swift:163-201`; `mobile/conch-ios/conch-ios/TalkController.swift:828-853`). Other status chips are inert. |
| Vertical conversation scroll | Native drag. | Scrolls; an instantiated ScrollViewReader proxy is never used, so new content does not auto-follow (`mobile/conch-ios/conch-ios/SessionView.swift:84-126`). |
| Tool row | Button; glyph/status/name/detail, no disclosure indicator. | Toggles nonempty result; empty-result buttons silently no-op (`mobile/conch-ios/conch-ios/ConversationStack.swift:71-113`). |
| File-change row | File and capped `+`/`−` excerpt. | Toggles changed lines only, not file/full diff (`mobile/conch-ios/conch-ios/ConversationStack.swift:123-183`). |
| Question option “radio/checkbox” rows | Visually selectable circles/squares. | **Unreachable/inert:** deliberately plain `HStack`, not Button; taps do nothing (`mobile/conch-ios/conch-ios/ConversationStack.swift:204-250`). |
| Multiline composer | 1–7 lines, shared typed/dictated per-session draft; Return inserts newline. | Reads/writes TalkController and persists committed text per session (`mobile/conch-ios/conch-ios/SessionView.swift:389-403,500-506`; `mobile/conch-ios/conch-ios/TalkController.swift:146-180,264-283`). |
| Photos `+` | System images-only picker. | Prepares/resizes and previews up to four images; no camera, Files, paste/share, drag, or screenshot-specific path (`mobile/conch-ios/conch-ios/SessionView.swift:404-415,524-567`; `mobile/conch-ios/conch-ios/ImageUpload.swift:96-122,154-254`). |
| Attachment `×` | Each 64pt thumbnail. | Removes it and clears attachment error (`mobile/conch-ios/conch-ios/SessionView.swift:337-378`). |
| Draft trash | Appears for any text/attachment; hidden while sending. | Without confirmation, clears draft, every attachment/error, and active capture (`mobile/conch-ios/conch-ios/SessionView.swift:416-432`; `mobile/conch-ios/conch-ios/TalkController.swift:246-261`). |
| Mic / square | Always cyan mic; square while this session listens; disabled during any shared `.sending`. | Starts/switches/closes **local** speech recognition and preserves words. It never sends (`mobile/conch-ios/conch-ios/SessionView.swift:436-449,599-612`; `mobile/conch-ios/conch-ios/TalkController.swift:175-190`). |
| Amber Stop turn | Only while row is working, composer/attachments empty, not sending. | POSTs immediate session interrupt; returned success Bool is ignored, so no pending/failure state (`mobile/conch-ios/conch-ios/SessionView.swift:450-465,509-517`; `mobile/conch-ios/conch-ios/BridgeClient.swift:212-220`). |
| Send / spinner | Up arrow whenever text **or attachment** exists; spinner for shared sending phase. | Finalizes local recognition, uploads images, injects paths+text, and clears only after acknowledgement (`mobile/conch-ios/conch-ios/SessionView.swift:467-485,569-597`; `mobile/conch-ios/conch-ios/TalkController.swift:192-225,671-741`). **Attachment-only is a no-op:** controller returns before upload when text is empty (`mobile/conch-ios/conch-ios/TalkController.swift:203-212`). |
| **Open Settings** | Permission-denied recovery text button. | Opens this app's iOS Settings URL (`mobile/conch-ios/conch-ios/SessionView.swift:287-305`). |
| Deliverable **Done** / swipe-down | Sheet toolbar/native dismissal. | Dismisses and removes the downloaded temporary file on disappear (`mobile/conch-ios/conch-ios/DeliverableSheet.swift:54-82`). |
| Web artifact | In-app WKWebView, no browser chrome. | Navigates web content; no external-open/share/retry/load-error control (`mobile/conch-ios/conch-ios/DeliverableSheet.swift:23-29,218-229`). |
| Local artifact | Image, video, PDF, Markdown/HTML/text preview; video starts muted if daemon mute is true. | Downloads scoped file to temp then routes by extension (`mobile/conch-ios/conch-ios/DeliverableSheet.swift:23-51,67-147`; `mobile/conch-ios/conch-ios/BridgeClient.swift:326-339`). Unsupported/corrupt content has no handoff/retry; unsupported is passive copy only. |

**Unreachable iPhone control:** `YourTurnBubble` defines a long-press context menu with **Discard draft**, but no live view instantiates it (`mobile/conch-ios/conch-ios/SessionView.swift:637-667`). The authored app contains no other context menus, row swipes, long-presses, drag/drop targets, hardware-keyboard shortcuts, camera capture, Files picker, share extension, or dismiss/restore action.

#### iPhone lifecycle and settings controls

- Active scene: reconnect, restart telemetry, claim phone audio; background: close mic, yield audio, stop bridge; inactive: no action (`mobile/conch-ios/conch-ios/ConchApp.swift:74-138`). Because `stop` is terminal in both transports, the first background makes later foreground/menu reconnect a no-op (`mobile/conch-ios/conch-ios/DirectHTTPTransport.swift:33-60`; `mobile/conch-ios/conch-ios/RelayTransport.swift:276-302`).
- Current TTS may finish in background, fires `onFinishedReading`, and SessionView starts mic without checking scene phase; this can reopen capture after the background handler closed it (`mobile/conch-ios/conch-ios/SpeechController.swift:287-329`; `mobile/conch-ios/conch-ios/SessionView.swift:230-239`).
- Settings **Done** dismisses; **Try again** refetches after load error. Booleans are switches, numbers are steppers, enums are menu pickers, environment values are disabled. A failed apply replaces the whole list with the error view (`mobile/conch-ios/conch-ios/SettingsView.swift:20-45,88-120,127-195`). Choice-less strings are inert text, so `phone-relay-url` is also uneditable here (`mobile/conch-ios/conch-ios/SettingsView.swift:178-183`).

### 1C. terminal theater

Theater is the default only with both stdin/stdout TTY and no `CONCH_TUI=footer`; it enters alternate screen, hides cursor, and enables SGR mouse unless `CONCH_NO_MOUSE=1` (`src/status.ts:1183-1188,1219-1226`). Headless draws nothing. Detached tmux suppresses draws while state/actions continue, with a later state event or 20-second timer repaint (`src/status.ts:1269-1323`; `src/daemon.ts:4959-4961`).

#### Theater keyboard

| Key | Appearance/states | Actual action |
|---|---|---|
| `↑` / `↓` | `↑↓ park`; cyan `▸` on parked row. | Moves through status-sorted visible sessions; moving beyond either edge releases selection (`src/daemon.ts:5120-5142`; `src/theater-navigation.ts:31-46`). |
| Esc | `esc release`. | First clears app text selection, second releases parked row (`src/daemon.ts:5240-5247`; `src/status.ts:1339-1343`). |
| Space, idle | `space talk`. | Wakes painted parked, active, or last-turn target; no target only logs/speaks failure (`src/daemon.ts:2821-2848,5144-5147,5231-5236`). |
| Space, busy | `space stop`. | Cancels current/pending speech, queued wake/recite, and closes/drains dictation (`src/daemon.ts:5149-5160`). |
| `p` | `p pause`; parked row scopes it, otherwise global. | Pause holds/replays newest work. Session resume can exempt one session from global pause (`src/theater-controls.ts:16-28`; `src/instant-controls.ts:92-130`; `src/pause-controller.ts:272-313,338-418`). |
| `m` | `m mute`, fully visible. | Separate global/session mute forgets held/queued/latest work, persists, and does not replay (`src/theater-controls.ts:30-38`; `src/instant-controls.ts:54-78,132-156`). |
| Enter (CR) | `⏎ actions`. | Opens actions for parked/active/last row; LF is not accepted at top level (`src/daemon.ts:5221-5230`; `src/theater-navigation.ts:48-50`). |
| `r` | `r recite`. | Interrupts current exchange and reads target latest reply from start, read-only (`src/daemon.ts:2759-2818,3283-3290,5097-5117`). |
| `\` | `\ pane`. | Toggles content pane; logs/modal can force it visually open while silently retaining the toggle (`src/status.ts:929-944`; `src/daemon.ts:5249-5252`). |
| `l` | `l logs`. | Toggles future renderer-received log pane only; no file history is loaded (`src/status.ts:1167-1170,1520-1527`; `src/daemon.ts:5255`). |
| `,` | `, settings`. | Opens settings overlay and silently acquires a global settings pause/interrupt (`src/daemon.ts:4492-4498,5217-5220`; `src/pause-controller.ts:86-103`). |
| `?` / hidden `h` | `? help`; `h` undisclosed. | Forces pane/logs on and appends help to live log (`src/daemon.ts:5018-5023,5259-5269`). |
| `q` / raw Ctrl-C | `q quit`. | Immediate daemon shutdown and terminal restoration; Ctrl-C falls through overlays (`src/daemon.ts:4782-4803,5263-5264`). |
| `1`…`9` | Hidden; rows show no numbers. | Wakes nth status-sorted visible row (`src/daemon.ts:5064-5077,5253`). |
| `s` | Hidden. | Forces logs/pane and prints numbered live sessions (`src/daemon.ts:5025-5036,5254`). |
| `v` | Expanded help only, absent keybar. | Auditions every session voice serially; refuses while busy/paused/muted (`src/daemon.ts:5038-5061,5256`). |
| Other bytes | No composer. | Tab, Backspace, Ctrl-D/Z/L, left/right outside overlays, ordinary letters, and coalesced chunks are consumed and do nothing (`src/daemon.ts:5196-5264`). |

#### Session-actions overlay

Opening Enter's modal silently globally pauses/interrupts even if the target row is idle and another session is speaking (`src/daemon.ts:4563-4567`; `src/pause-controller.ts:86-103`). Mouse is disabled while it is open.

| Control | States/appearance | Actual action |
|---|---|---|
| `↑`/`↓` | Cyan selected action; wraps rows. | Moves among Voice, Prioritize, Rename, Dismiss (`src/session-actions-overlay.ts:70-82,174-235`). |
| Voice `←`/`→` | Cycles published voices; “automatic” is distinct. | Changes preview choice; Space previews, Enter persists, lowercase `a` resets to automatic (`src/session-actions-overlay.ts:292-379`; `src/daemon.ts:4500-4520`). Preview can interrupt unrelated speech because modal already owns global pause. |
| Prioritize `←`/`→`/Space/Enter | Toggle-style selected value. | Persists per-session priority; it affects queue cohort but is not shown in ledger (`src/session-actions-overlay.ts:381-395`; `src/daemon.ts:4522-4529`). |
| Rename Enter/type/Backspace/Enter | ASCII-only editor; cursor suffix. | Starts replacement, accepts safe ASCII, commits canonical session label; arrow movement silently abandons edit (`src/session-actions-overlay.ts:84-85,209-214,237-255,398-423`). |
| Dismiss Enter twice | First Enter arms bold red confirmation; any unrelated key disarms. | Second Enter dismisses/hides and session-mutes while keeping agent running (`src/session-actions-overlay.ts:259-289,425-437`; `src/daemon.ts:4544-4560`). |
| Esc | Editing: cancels edit; otherwise closes and restores prior pause state. | Closes modal (`src/session-actions-overlay.ts:174-235`). `q` is trapped; Ctrl-C still quits. |
| Restore | Controller case exists, but no action row/key. | **Unreachable** from theater (`src/session-actions-overlay.ts:29-30,58-82`; `src/daemon.ts:1125-1141`). |

#### Settings overlay

All 26 registry rows are displayed with `[env]`, `[file]`, or `[default]`; opening silently globally pauses (`src/settings-overlay.ts:62-113`; `src/daemon.ts:4492-4498`). `↑/↓` wrap; enum `←/→` wraps and commits; numeric arrows adjust 0.1 or 1 and commit; Space toggles booleans; numeric typing replaces the entire value and Enter commits; Backspace edits; Esc closes; unknown keys are trapped (`src/settings-overlay.ts:115-233`). Environment values are presented with provenance, but the overlay still relies on server rejection rather than disabling interaction. Two controls are impossible: reset/unset exists in protocol but not overlay, and string input has no handler, making `phone-relay-url` an inert visible row (`src/settings.ts:299-309,693-696`; `src/settings-overlay.ts:129-189`). `phone-port` is a `number`, so arrows change it by 0.1 (`src/settings.ts:289-298`; `src/settings-overlay.ts:184-188`).

#### Theater mouse, gestures, and display states

| Mouse/gesture | Actual action |
|---|---|
| Wheel anywhere | Coordinates are ignored; scrolls current pane three lines/notch, even over header/ledger/footer. Only reply/preview/log documents are scrollable (`src/daemon.ts:5202-5207`; `src/status.ts:1045-1058`). |
| Left drag in scrollable pane | Inverse-highlight selection, edge autoscroll, then copies control-stripped text to native clipboard and OSC 52; optimistic “copied” log even if clipboard fails (`src/status.ts:1086-1151`; `src/theater-mouse.ts:206-236`). |
| Left click / ledger click | Clears a text selection and otherwise does nothing. Rows have no mouse hit target (`src/status.ts:1105-1117`). |
| Drag in current speaking/dictation pane | **Unreachable:** live panes are static/non-scrollable, and selection requires `layout.scrollable` (`src/status.ts:695-768,1105-1122`). |
| Right/middle/modifier click | Clears app selection or behaves like unmodified input; no context menu/hover (`src/status.ts:1105-1113`; `src/theater-mouse.ts:99-140`). |

Theater row precedence is **muted > paused > review > needs/waiting/working > idle**, so mute/pause hides urgent state. Header can simultaneously show muted and paused. Parked (`▸`) and active (`▎`) are independent (`src/status.ts:355-440,491-515`). Speaking always displays “the mic opens when it finishes,” even for read-only recite (`src/status.ts:695-701,748-768`; `src/daemon.ts:3283-3290`).

### 1D. terminal footer

Footer is selected by `CONCH_TUI=footer`; it shows semantic rows, one permanently reserved dictation line, and `↑↓ park · space talk · p pause · m mute · l logs · ? help · q quit` (`src/status.ts:159-233`; `src/theater-controls.ts:44-45`). Rows show muted, paused, matching-label live mic/speaking/transcribing, review/status/idle in that order; global mute wins over pause in the banner (`src/panel.ts:526-581`). Duplicate labels can mark the wrong row because footer matches live activity by label, unlike theater's id (`src/panel.ts:551-553`).

**Every footer control is unreachable.** Dispatch is true only for theater (`src/status.ts:1208-1214`), but daemon still puts stdin in raw mode and returns on every input byte when dispatch is false (`src/daemon.ts:5186-5195`). Thus arrows, Space, `p`, `m`, `l`, `?`, `q`, raw Ctrl-C, comma, Enter, numbers, `s`, `v`, `r`, and ordinary terminal typing are swallowed. External OS signals can still terminate it. Footer also ignores overlays/pane/scroll/pointer methods (`src/status.ts:191-233`).

### 1E. exhaustive settings registry

These are all published rows—not a sample. The action semantics are implemented by the control kinds described above; “hook” values require future hook/session processes while “live” values update the daemon immediately (`src/settings.ts:86-104,171-465`).

| Key (kind) | What the setting actually feeds | Mac | iPhone | Theater |
|---|---|---|---|---|
| `end-silence` (number) | Silence ending utterance | field/stepper | stepper | numeric |
| `mic-gain` (number) | software capture gain | field/stepper | stepper | numeric |
| `hold-submit-delay` (number) | held-dictation submit delay | field/stepper | stepper | numeric |
| `listen-window` (number) | time to begin speaking | field/stepper | stepper | numeric |
| `typing-grace` (number) | recent-input visual grace | field/stepper | stepper | numeric |
| `barge-threshold` (number) | speech interruption threshold | field/stepper | stepper | numeric |
| `voice-speed` (number) | Kokoro synthesis rate | field/stepper | stepper | numeric |
| `keystroke-fallback` (boolean) | inject by typing outside tmux | switch | switch | Space |
| `away-after` (number) | become quiet after Mac inactivity | field/stepper | stepper | numeric |
| `phone` (boolean) | enable phone bridge | switch | switch | Space |
| `phone-port` (number) | phone bridge port | field/stepper | stepper | **0.1 arrows** |
| `phone-relay-url` (string) | relay worker URL | **inert unsupported** | **inert text** | **no input handler** |
| `read-full` (boolean) | read full final response | switch | switch | Space |
| `interrupt-on-manual-reply` (boolean) | stop audio on typed session reply | switch | switch | Space |
| `handoff-order` (enum) | newest/oldest/urgency queue choice | menu | menu | arrows |
| `reveal-on-turn` (boolean) | raise session window | switch | switch | Space |
| `reveal-typing-grace` (number) | suppress window raise after input | field/stepper | stepper | numeric |
| `working-mic` (boolean) | open mic during remaining work | switch | switch | Space |
| `voice-qa` (boolean) | answer Conch-prefixed questions without injection | switch | switch | Space |
| `resume-digest` (boolean) | one resume briefing vs replay | switch | switch | Space |
| `announce-summary` (boolean) | synthesize short spoken summary | switch | switch | Space |
| `haiku-timeout` (number) | fast-model summary/QA timeout | field/stepper | stepper | numeric |
| `meeting-autopause` (boolean) | pause when another app owns default mic | switch | switch | Space |
| `announce-sentences` (integer) | leading sentences announced | field/stepper | stepper | integer |
| `announce-max-chars` (integer) | announcement character cap | field/stepper | stepper | integer |
| `say-rate` (integer) | macOS fallback words/minute | field/stepper | stepper | integer |

Descriptor order, kinds, bounds, defaults, and help are authoritative at `src/settings.ts:171-465`. Mac uniquely exposes reset/unset; iPhone and theater do not. All three fail to edit the one freeform string.

## Part 2 — cross-surface comparison

Legend: **Present** = same capability and expected semantics; **Absent** = no path; **Different** = a path exists but its behavior/scope/feedback differs. “TUI” means theater unless the cell explicitly says footer.

| Capability | macOS | iPhone | TUI | Drift that matters |
|---|---|---|---|---|
| See live sessions/status | **Present** | **Present** | **Different** | All render published rows. Theater hides review/needs under pause/mute; Mac/iPhone keep urgent state ahead of mode (`mac-app/conch-mac/DashboardView.swift:1145-1176`; `mobile/conch-ios/conch-ios/Models.swift:176-247`; `src/status.ts:409-427`). Footer live matching is label-based. |
| Explicitly select a session | **Present** click/arrows | **Present** navigation | **Present** arrows | TUI mouse clicks do not select; iPhone selection is screen navigation, not control scope (`src/status.ts:1105-1117`; `mobile/conch-ios/conch-ios/LedgerView.swift:49-61`). |
| Return to all/global scope | **Present** All sessions/Esc | **Absent** (always global mode) | **Present** Esc | Mac has a visible control; TUI only keyboard (`mac-app/conch-mac/DashboardView.swift:597-612`; `src/daemon.ts:5240-5247`). |
| Start talking from idle | **Different** daemon Mac mic | **Different** local phone recognizer | **Different** daemon Mac mic | Same mic glyph/“talk” concept, three action models (`mac-app/conch-mac/DashboardView.swift:1548-1558`; `mobile/conch-ios/conch-ios/SessionView.swift:599-612`; `src/daemon.ts:5231-5236`). |
| Tap mic again | **Different** global stop if nonidle | **Different** close local mic, keep words | **Different** Space stops current daemon exchange | iPhone never sends; Mac/TUI stop speech/recite as well as capture. |
| Type a reply | **Present** | **Present** | **Absent** | Terminal has no composer; unrecognized keys are swallowed (`src/daemon.ts:5196-5264`). |
| Send with keyboard Return | **Present** Return; Shift-Return newline | **Absent** Return newline only | **Absent** | `ComposerView` owns Return; iPhone has no hardware send shortcut (`mac-app/conch-mac/ComposerView.swift:210-219`; `mobile/conch-ios/conch-ios/SessionView.swift:389-403`). |
| Draft per session | **Different** view-local, not keyed | **Present** per-session map | **Absent** | Mac can carry the same `@State` composer content across focused rows; iPhone parks by id (`mac-app/conch-mac/ComposerView.swift:41-43`; `mac-app/conch-mac/DashboardView.swift:1535-1568`; `mobile/conch-ios/conch-ios/TalkController.swift:264-283`). |
| Draft survives relaunch | **Absent** | **Present** committed text | **Absent** | iPhone stores committed text in UserDefaults; live partial is not persisted (`mobile/conch-ios/conch-ios/TalkController.swift:146-168,284-304`). |
| Typing and dictation share draft | **Absent** | **Present, with live-edit bug** | **Absent** | Mac never merges daemon dictation into `draft`; iPhone getter merges partial but setter can duplicate it (`mac-app/conch-mac/ComposerView.swift:173-185`; `mobile/conch-ios/conch-ios/TalkController.swift:140-173,227-243`). |
| Acknowledged send / retry safety | **Different** clears immediately | **Present** clears after ack | Voice pipeline only | Mac loses text/files on socket failure; iPhone preserves them (`mac-app/conch-mac/ComposerView.swift:343-363`; `mobile/conch-ios/conch-ios/TalkController.swift:192-225`). |
| Attach files/images | **Present** file picker/drop | **Different** Photos only | **Absent** | Mac picker supports image/PDF/text and unvalidated file drop; iPhone up to four prepared photos (`mac-app/conch-mac/ComposerView.swift:365-383`; `mobile/conch-ios/conch-ios/SessionView.swift:524-567`). |
| Image-only send | **Present** path is composed content | **Broken** visible Send no-ops | **Absent** | iPhone UI and controller disagree on `canSend` (`mobile/conch-ios/conch-ios/SessionView.swift:519-522`; `mobile/conch-ios/conch-ios/TalkController.swift:203-212`). |
| Stop a running agent | **Present**, hidden by draft | **Present**, hidden by draft | **Absent** | Mac/iPhone expose interrupt only when composer empty; TUI Space stops Conch audio/capture, not the underlying agent (`mac-app/conch-mac/ComposerView.swift:123-149`; `mobile/conch-ios/conch-ios/SessionView.swift:450-485`; `src/daemon.ts:5149-5160`). |
| Recite latest output | **Different** daemon speech | **Different** local AVSpeech and separate reply field | **Different** daemon speech | iPhone cannot recite visible conversation without `replyText`; TUI recite copy falsely promises mic afterward (`mobile/conch-ios/conch-ios/SessionView.swift:142-161`; `src/status.ts:695-701`). |
| Automatic finished-turn speech | **Present** daemon/Mac | **Different** local phone, singular reply | **Present** daemon/Mac | Audio lease picks phone vs Mac, but phone consumes one global `reply`, so simultaneous completions can be missed (`mobile/conch-ios/conch-ios/SpeechController.swift:57-96`; `src/panel.ts:313-323`). |
| Background behavior | **Present** daemon continues; app can notify/front | **Broken/different** closes mic/bridge and cannot reconnect | **Present** daemon remains process; detached draw suppression | Mac review notification may front window (`mac-app/conch-mac/ConchMacApp.swift:180-208,244-258`). iPhone lifecycle is terminal for cached transport. |
| Global Manual/pause | **Present** | **Present** | **Present** `p` | All map pause/hold, but iPhone stops local TTS only after network returns (`mobile/conch-ios/conch-ios/LedgerView.swift:159-183`; `src/pause-controller.ts:272-313`). |
| Per-session pause/resume | **Present** selected scope | **Absent** | **Present** parked scope | Mac explicitly resumes selected session under global pause; theater `p` tests row's scoped paused bit and can instead send pause under global state (`mac-app/conch-mac/ContentView.swift:227-240`; `src/theater-controls.ts:16-28`). |
| Mute/forget | **Different** hidden `M`, header only when already muted | **Absent control**, model still obeys | **Present** `m` | Retired feature is most complete in TUI. iPhone can be stuck visually Auto yet silent if daemon is muted (`mobile/conch-ios/conch-ios/LedgerView.swift:159-203`; `mobile/conch-ios/conch-ios/SpeechController.swift:64-91`). |
| Dismiss session | **Present** context menu + Undo | **Absent** | **Present** action modal | Dismiss also session-mutes/forgets, not merely hides (`src/daemon.ts:4544-4560`). |
| Restore session | **Present** Undo/context menu | **Absent/invisible** | **Absent/unreachable** | Daemon publishes/implements it, but iPhone decoder drops it and TUI menu omits it (`src/panel.ts:361-365`; `mobile/conch-ios/conch-ios/Models.swift:147-170`; `src/session-actions-overlay.ts:70-82`). |
| Rename session | **Present** context + inline | **Absent** | **Present** modal | TUI editor restricts names to safe ASCII and arrow navigation abandons draft (`src/session-actions-overlay.ts:84-85,209-255`). |
| Prioritize session | **Absent** | **Absent** | **Present** modal | Priority is hidden from ledger after being set (`src/session-actions-overlay.ts:381-395`; `src/daemon.ts:4522-4529`). |
| Per-session voice | **Absent** in dashboard | **Absent** | **Present** preview/persist/reset | Mac has pairing/settings, but the only audited per-session voice action is theater overlay (`src/session-actions-overlay.ts:292-379`). |
| Inspect full conversation | **Present, auto-scroll defect** | **Present, no auto-follow** | **Different** latest pane only | Mac's “pinned” flag is never updated, so streaming can yank a reader to bottom; iPhone's proxy is never used, so it never follows. Terminal renders latest reply/preview, not the structured sequence (`mac-app/conch-mac/ConversationStackView.swift:14-63`; `mobile/conch-ios/conch-ios/SessionView.swift:84-126`; `src/status.ts:642-778`). |
| Expand tool result | **Present** | **Present** | **Absent** | Empty tool rows remain false buttons on both graphical apps. |
| Inspect file changes | **Present** excerpt | **Present** excerpt | **Absent** | Neither app opens the source file/full diff from the change row (`mac-app/conch-mac/ConversationStackView.swift:297-356`; `mobile/conch-ios/conch-ios/ConversationStack.swift:123-183`). |
| Answer published options | **Absent specialized control** | **Broken false affordance** | **Absent** | iPhone draws radio/checkbox options that intentionally do nothing; Mac model has no equivalent actionable option path in the audited stack (`mobile/conch-ios/conch-ios/ConversationStack.swift:204-250`). |
| Open web artifact | **Present** embedded + browser escape | **Different** embedded only | **Absent** | TUI stores but never consumes link (`mac-app/conch-mac/ReviewView.swift:284-305`; `mobile/conch-ios/conch-ios/DeliverableSheet.swift:218-229`; `src/panel.ts:31-45`). |
| Open local artifact | **Present** direct local rendering | **Different** scoped download/preview subset | **Absent** | iPhone local HTML cannot load sibling assets; unsupported has no share/handoff (`mobile/conch-ios/conch-ios/DeliverableSheet.swift:110-147,232-248`). |
| Artifact failure recovery | **Present** retry/back/browser/reveal | **Mostly absent** | **Absent** | iPhone corrupt PDF/video can be blank; web has no load error UI. |
| Notifications/badge | **Present** review notification + Dock badge | **Absent** local notification/badge code | **Absent** | Mac can front window if not recently active (`mac-app/conch-mac/ConchMacApp.swift:180-208,244-258`; `mac-app/conch-mac/StateStore.swift:619-627`). |
| Logs | **Present** dashboard toggle | **Different** connection journal in Settings | **Present** theater future-only; dead footer | iPhone journal is capped/in-memory (`mobile/conch-ios/conch-ios/BridgeClient.swift:18-33`); theater does not load log history (`src/status.ts:1167-1170`). |
| Shortcut/help discoverability | **Present**, inaccurate under focus and still says Mute | **Absent** | **Different** incomplete help; footer deceptive | Mac sheet `ContentView.swift:336-353`; terminal `src/theater-controls.ts:41-65`. |
| Mouse/gesture row controls | Click/right-click/drop | Tap/navigation/edge swipe/photo picker | Keyboard-first; mouse only scroll/copy | TUI has SGR mouse but cannot click rows (`src/status.ts:1105-1117`). |
| Settings bool/number/enum | **Present** | **Present** | **Present** | Mac numeric typing/blur; iPhone steppers can race stale snapshots; TUI replacement input. |
| Settings reset/unset | **Present** | **Absent** | **Absent** | Protocol supports unset (`src/settings.ts:693-696`). |
| Settings freeform string | **Absent** | **Absent** | **Absent** | All show `phone-relay-url`; none can edit it. |
| Pair/unpair phone | **Present** generates code | **Present** pairs/unpairs | CLI/daemon backing, no TUI control | Mac pairing code is display-side; iPhone performs scan/connect/credential deletion. |
| Daemon-down recovery | **Present** Start/probe/frozen ledger | **Different** reconnect menu, but post-background broken | **N/A** TUI is daemon | Mac requires two spaced liveness failures before frozen state (`mac-app/conch-mac/StateStore.swift:651-676,737-756,801-818`). |
| Empty-state recovery | Informative, Start if daemon dead | Informative, retry hidden in menu | Hidden `s` is only visible explanation | TUI Enter/Space/r failures usually go to hidden logs (`src/daemon.ts:5064-5106`; `src/status.ts:1522-1527`). |

### The known drift questions, answered directly

1. **What does the mic do?** Mac and theater wake/stop the daemon's Mac-side voice loop. iPhone toggles local SFSpeech capture, parks the recognized words, and never injects them until Send (`mac-app/conch-mac/DashboardView.swift:1548-1558`; `src/daemon.ts:5231-5236`; `mobile/conch-ios/conch-ios/SessionView.swift:599-612`).
2. **What happens in background?** Mac's daemon continues and the app can notify/front review. iPhone closes mic, yields audio, then permanently stops the current bridge. A finishing background utterance can subsequently reopen its mic. TUI daemon keeps working while detached, suppressing only draws (`mac-app/conch-mac/ConchMacApp.swift:180-208`; `mobile/conch-ios/conch-ios/ConchApp.swift:74-130`; `mobile/conch-ios/conch-ios/SpeechController.swift:287-329`; `src/status.ts:1269-1323`).
3. **Is a draft shared between typing and dictation?** iPhone: yes, per session and persisted, except a live partial can duplicate during editing. Mac: no; dictation is a separate published display string and Send composes only attachment paths plus typed `draft`. TUI: no draft (`mobile/conch-ios/conch-ios/TalkController.swift:140-180,227-243`; `mac-app/conch-mac/ComposerView.swift:173-185,343-354`).
4. **What does pause/manual mean?** It holds the newest turn(s) for replay and can be global/session-scoped on Mac/TUI; iPhone only exposes global. It does not mean “forget.” Mute still means forget and remains separately implemented (`src/instant-controls.ts:54-78,92-156`; `src/pause-controller.ts:272-313,338-418`).
5. **Can sessions be dismissed/restored?** Mac: both, with six-second Undo plus persistent dismissed list. Theater: dismiss but no restore. iPhone: neither, and it discards published restoration state (`mac-app/conch-mac/StateStore.swift:160-177,478-491`; `src/session-actions-overlay.ts:70-82`; `mobile/conch-ios/conch-ios/Models.swift:147-170`).
6. **How is an artifact opened?** Mac review pane automatically routes local/web content and offers browser/Finder recovery. iPhone requires tapping the review card, downloads local files, and offers a narrower preview with no handoff. TUI's stored `review.link` is never connected to input (`mac-app/conch-mac/ReviewView.swift:113-305`; `mobile/conch-ios/conch-ios/DeliverableSheet.swift:23-147`; `src/status.ts:421-433`).

## Part 3 — user flows walked against code

The verdict applies to the named surface/path; “Awkward” means the goal is achievable but the first reasonable action, number of steps, hidden scope, or feedback is wrong.

1. **“I'm on a walk and an agent asks me a question.” — AWKWARD (iPhone).** The session is visible and the composer works, but prominent radio/checkbox options are inert. A person taps an option first; nothing happens. They must type the label and tap Send (`mobile/conch-ios/conch-ios/ConversationStack.swift:204-250`; `mobile/conch-ios/conch-ios/SessionView.swift:389-485`).

2. **“I speak an answer on my phone and tap the mic again expecting it to go.” — AWKWARD.** Second tap only closes recognition and retains text; then Send is required. The stale controller comment still says tap to start/tap to send (`mobile/conch-ios/conch-ios/SessionView.swift:599-612`; `mobile/conch-ios/conch-ios/TalkController.swift:118-123`).

3. **“I type half an answer, then dictate the rest on my phone.” — WORKS, with a live-edit edge.** Both use the same per-session committed buffer and Send finalizes it (`mobile/conch-ios/conch-ios/TalkController.swift:146-180,192-225`). Editing while partial recognition is live can duplicate that partial because the setter re-commits visible partial without clearing it (`mobile/conch-ios/conch-ios/TalkController.swift:227-243`).

4. **“I type half an answer, then dictate the rest on Mac.” — BROKEN as a shared draft.** Dictation is displayed from daemon state but not inserted into `draft`; composed text includes only file paths and typed draft (`mac-app/conch-mac/ComposerView.swift:173-185,343-354`). The two input modes do not form one message.

5. **“I press Return in the Mac composer.” — WORKS.** Plain Return triggers Send; Shift-Return is deliberately left as newline (`mac-app/conch-mac/ComposerView.swift:147,210-219`).

6. **“I press Return in the iPhone composer with a hardware keyboard.” — AWKWARD.** It inserts newline, and no keyboard send shortcut exists; the user must tap the arrow (`mobile/conch-ios/conch-ios/SessionView.swift:389-403,467-485`). Pairing fields likewise do nothing on Return (`mobile/conch-ios/conch-ios/PairingView.swift:220-227`).

7. **“I switch Mac sessions after writing a draft.” — AWKWARD / at risk of wrong recipient.** Composer draft is view-local `@State` and the composer position is not `.id(row.id)`; focus changes the `row` passed into the same structural view (`mac-app/conch-mac/ComposerView.swift:41-43`; `mac-app/conch-mac/DashboardView.swift:1535-1568`). There is no per-session draft map or visible warning; the send target is whichever row is focused now.

8. **“I switch iPhone sessions after writing a draft.” — WORKS.** TalkController parks committed text by session and restores it on return (`mobile/conch-ios/conch-ios/TalkController.swift:264-283`). Prepared photos do not share that behavior and are lost with the view (`mobile/conch-ios/conch-ios/SessionView.swift:17-21`).

9. **“I send from Mac while the daemon is down.” — BROKEN.** Send dispatches, then unconditionally clears typed text and attachments; StateStore only starts a later liveness probe on failure and cannot restore the payload (`mac-app/conch-mac/ComposerView.swift:343-363`; `mac-app/conch-mac/StateStore.swift:116-130`).

10. **“The phone has no signal when I tap Send.” — AWKWARD/BROKEN by transport.** LAN times out and preserves the draft. Relay can queue before authentication indefinitely, leaving an uncancellable spinner; background fails it but permanently stops that bridge (`mobile/conch-ios/conch-ios/DirectHTTPTransport.swift:62-76`; `mobile/conch-ios/conch-ios/RelayTransport.swift:304-372,634-703`; `mobile/conch-ios/conch-ios/TalkController.swift:213-224`).

11. **“I send a screenshot with a note from my phone.” — WORKS.** Picker prepares up to four images, uploads chunks, receives Mac paths, then injects paths plus text; ack failure preserves the content (`mobile/conch-ios/conch-ios/SessionView.swift:524-595`; `mobile/conch-ios/conch-ios/BridgeClient.swift:159-191`).

12. **“I send only a screenshot; the screenshot is the message.” — BROKEN.** Attachment makes Send visible, but TalkController returns before upload if committed text is empty. Nothing happens and no error appears (`mobile/conch-ios/conch-ios/SessionView.swift:519-522`; `mobile/conch-ios/conch-ios/TalkController.swift:203-212`).

13. **“I drag a PDF onto the Mac composer.” — WORKS, but inconsistent validation.** Drop accepts any file URL; picker explicitly limits image/PDF/plain text. The path is injected on Send (`mac-app/conch-mac/ComposerView.swift:158-170,343-383`).

14. **“I want to stop a session that's going the wrong way before typing.” — WORKS on Mac/iPhone.** Empty composer + working row shows amber Stop and sends targeted interrupt (`mac-app/conch-mac/ComposerView.swift:123-132`; `mobile/conch-ios/conch-ios/SessionView.swift:450-465`). TUI has no agent interrupt path; Space only stops Conch audio/capture (`src/daemon.ts:5149-5160`).

15. **“I already typed a correction, then need to stop the wrong-going session.” — AWKWARD.** Any draft/attachment hides Stop behind Send on both graphical apps. The first thing a person seeks is Stop; on iPhone the only way to recover it is trashing the prepared correction and attachments (`mac-app/conch-mac/ComposerView.swift:123-149`; `mobile/conch-ios/conch-ios/SessionView.swift:416-485`).

16. **“I want the last answer read again.” — WORKS, differently.** Mac/TUI recite through daemon speech; iPhone reads the separate current `replyText` locally (`mac-app/conch-mac/DashboardView.swift:1560-1562`; `src/daemon.ts:5097-5117`; `mobile/conch-ios/conch-ios/SessionView.swift:142-161`).

17. **“I can see an assistant answer on iPhone, so I tap speaker.” — IMPOSSIBLE for some conversations.** Conversation items render independently, while speaker enablement requires separate `replyText`; there is no per-message recite (`mobile/conch-ios/conch-ios/SessionView.swift:93-104,147-160`).

18. **“I recite in theater and wait for the promised mic.” — AWKWARD/BROKEN COPY.** The pane always says the mic opens when speech finishes, but recite explicitly prevents mic creation (`src/status.ts:695-701`; `src/daemon.ts:3283-3290`).

19. **“I switch to Manual because I need quiet.” — WORKS on Mac; AWKWARD on iPhone.** Both send global pause/hold. iPhone awaits the network before stopping its current local speech, so audio can continue while the icon optimistically shows Manual (`mac-app/conch-mac/ContentView.swift:227-243`; `mobile/conch-ios/conch-ios/LedgerView.swift:159-183`).

20. **“I want one session quiet but the others automatic.” — WORKS on Mac/theater; IMPOSSIBLE on iPhone.** Mac selection and theater parked cursor scope pause (`mac-app/conch-mac/ContentView.swift:232-240`; `src/instant-controls.ts:92-130`). iPhone mode is global only.

21. **“Everything is manual; I resume just one session.” — WORKS on Mac/theater, but theater is obscure.** The daemon supports per-session exemption under global pause (`src/instant-controls.ts:115-127`). Mac explicitly chooses scoped resume. Theater has no visible exemption state and its toggle decision can instead re-pause depending on scoped bit (`mac-app/conch-mac/ContentView.swift:227-240`; `src/theater-controls.ts:16-28`).

22. **“Mute was retired, so I press M expecting ordinary text or nothing.” — BROKEN product migration.** Outside an editable Mac field it still sends destructive mute; in the field it types `m`. Theater still exposes `m mute` as first-class. iPhone has no unmute path even though it obeys muted state (`mac-app/conch-mac/DashboardInputMonitor.swift:136-145`; `src/theater-controls.ts:30-63`; `mobile/conch-ios/conch-ios/SpeechController.swift:64-91`).

23. **“I pause using P while typing in the Mac composer.” — AWKWARD.** The monitor intentionally disables every shortcut under editable focus, so `p` goes into the reply. A person first tries the documented shortcut; actual replacement is clicking header Manual (`mac-app/conch-mac/DashboardInputMonitor.swift:46-52`; `mac-app/conch-mac/ContentView.swift:336-346`).

24. **“I recite using R while typing in the Mac composer.” — AWKWARD.** It types `r`; the visible speaker is the replacement. `M` is worse because it has no normal-state replacement (`mac-app/conch-mac/DashboardInputMonitor.swift:46-52,136-145`; `mac-app/conch-mac/ComposerView.swift:103-115`).

25. **“I background the phone for a minute and come back.” — BROKEN.** Background invokes terminal `bridge.stop`; active invokes `reconnectNow`, which both stopped transports reject. “Reconnect now” uses the same no-op path (`mobile/conch-ios/conch-ios/ConchApp.swift:74-130`; `mobile/conch-ios/conch-ios/DirectHTTPTransport.swift:33-60`; `mobile/conch-ios/conch-ios/RelayTransport.swift:276-302`).

26. **“I lock the phone while it is reading, then it finishes.” — BROKEN/privacy risk.** Background initially closes mic, but speech is allowed to finish and fires SessionView's callback, which opens mic without checking background state (`mobile/conch-ios/conch-ios/SpeechController.swift:287-329`; `mobile/conch-ios/conch-ios/SessionView.swift:230-239`).

27. **“I swipe back while the iPhone mic is open.” — BROKEN/privacy risk.** Navigation disappears the only visible close chip, while app-owned TalkController keeps recording. Ledger has no indicator/control (`mobile/conch-ios/conch-ios/SessionView.swift:163-201,230-241`; `mobile/conch-ios/conch-ios/ConchApp.swift:17-27`).

28. **“Two sessions finish at once.” — WORKS in daemon/theater/Mac queue; BROKEN for iPhone spoken completeness.** Daemon serializes queued audio using priority/handoff order (`src/daemon.ts:1042-1085,1877-1910`). iPhone considers only singular global `PublishedState.reply`; both conversations may display, but only the latest/coalesced reply is guaranteed spoken (`mobile/conch-ios/conch-ios/SpeechController.swift:64-95`; `src/panel.ts:313-323`).

29. **“I want to prioritize one of two finished sessions.” — WORKS only in theater, AWKWARD.** Enter → Prioritize changes queue eligibility, but the ledger never displays the priority afterward. Mac/iPhone have no path (`src/session-actions-overlay.ts:381-395`; `src/daemon.ts:4522-4529`).

30. **“I dismiss a noisy session but leave its agent running.” — WORKS on Mac/theater.** Both hide it; daemon also cancels audio/previews and session-mutes/forgets it while the process continues (`mac-app/conch-mac/ContentView.swift:185-190`; `src/daemon.ts:4544-4560`). iPhone: **IMPOSSIBLE**.

31. **“I change my mind and restore a dismissed session.” — WORKS on Mac; IMPOSSIBLE on iPhone/TUI.** Mac shows Undo and permanent dismissed rows. TUI action list has no restore; iPhone does not decode restoration state (`mac-app/conch-mac/DashboardView.swift:1035-1084`; `src/session-actions-overlay.ts:70-82`; `mobile/conch-ios/conch-ios/Models.swift:147-170`).

32. **“I press Space after theater dismissed the last-spoken session.” — AWKWARD/internally inconsistent.** Target filtering drops dismissed id, then unnamed wake resolves back to `lastTurn`; wake is a quiet override, so mic can reopen for a hidden muted session without restoring it (`src/daemon.ts:819-823,5144-5147,5231-5236`; `src/instant-controls.ts:240-266`).

33. **“I want to see what changed in a file.” — WORKS as an excerpt on Mac/iPhone; IMPOSSIBLE in TUI.** Tapping/clicking expands published added/removed lines, but neither opens the file/full diff (`mac-app/conch-mac/ConversationStackView.swift:297-356`; `mobile/conch-ios/conch-ios/ConversationStack.swift:123-183`).

34. **“I want the actual file after inspecting its change.” — AWKWARD/IMPOSSIBLE.** Mac change row lacks Reveal/Open despite artifact view having Finder support; iPhone has no file handoff; terminal has no change row. A person first clicks the filename, which only expands the excerpt (`mac-app/conch-mac/ConversationStackView.swift:297-356`; `mobile/conch-ios/conch-ios/ConversationStack.swift:123-183`; `src/status.ts:409-515`).

35. **“I open a web artifact.” — WORKS on Mac/iPhone; IMPOSSIBLE in TUI.** Mac embeds with visible origin and browser escape. iPhone embeds without external-open/load-error chrome. Terminal never consumes link (`mac-app/conch-mac/ReviewView.swift:284-305`; `mobile/conch-ios/conch-ios/DeliverableSheet.swift:218-229`; `src/status.ts:421-433`).

36. **“I open a local HTML report with CSS/images on iPhone.” — BROKEN.** Only the main HTML is downloaded to a random temp directory, so granting that empty directory read access cannot make sibling assets appear (`mobile/conch-ios/conch-ios/DirectHTTPTransport.swift:89-96`; `mobile/conch-ios/conch-ios/RelayTransport.swift:318-350`; `mobile/conch-ios/conch-ios/DeliverableSheet.swift:132-140,232-248`).

37. **“I open an unsupported artifact on iPhone and hand it to another app.” — IMPOSSIBLE.** It shows passive unsupported text only—no Quick Look, Share, Save, path copy, or “Open on Mac” (`mobile/conch-ios/conch-ios/DeliverableSheet.swift:142-147`). Mac offers Reveal in Finder (`mac-app/conch-mac/ReviewView.swift:216-254`).

38. **“I click a theater row with the mouse.” — AWKWARD.** Full-screen mouse tracking suggests row interaction; click merely clears text selection. Selection requires arrows (`src/status.ts:1101-1117`).

39. **“I copy the words currently being dictated/read in theater.” — IMPOSSIBLE through app mouse.** Live panes are non-scrollable/static and selection refuses to begin. Restart with `CONCH_NO_MOUSE=1` is the hidden native-terminal workaround (`src/status.ts:695-768,913-920,1105-1122`).

40. **“I turn logs on to see what happened an hour ago.” — AWKWARD.** Theater retains only future renderer-received logs; it never loads the always-written file. Turning logs off hides its own acknowledgement (`src/status.ts:1167-1170,1520-1527`; `src/daemon.ts:5255`). Mac has a direct log toggle; iPhone journal is capped/in-memory.

41. **“I come back to my desk after an hour.” — WORKS on Mac/theater, with caveats.** Daemon retained state; Mac foreground forces a liveness probe and can show reviews/badge (`mac-app/conch-mac/ConchMacApp.swift:19-32`; `mac-app/conch-mac/StateStore.swift:619-627`). Detached tmux repaints on next event/timer, up to 20 seconds later (`src/status.ts:1269-1323`; `src/daemon.ts:4959-4961`). The iPhone path is broken after background.

42. **“Nothing is running.” — WORKS on graphical apps, AWKWARD in theater.** Mac/iPhone show explanatory empty copy (`mac-app/conch-mac/DashboardView.swift:2406-2434`; `mobile/conch-ios/conch-ios/LedgerView.swift:216-254`). Theater's ordinary Space/r/Enter failures are hidden logs; undisclosed `s` is the only path that forces visible “no live sessions” (`src/daemon.ts:5025-5036,5064-5106`).

43. **“The daemon is down.” — WORKS on Mac, BROKEN as an iPhone recovery story.** Mac freezes stale ledger only after two liveness failures and exposes Start (`mac-app/conch-mac/StateStore.swift:651-676,737-756,801-818`; `mac-app/conch-mac/DashboardView.swift:211-234`). iPhone exposes Reconnect only in a menu and cannot recover a stopped cached transport. Terminal disappears because it is the daemon.

44. **“A session dies mid-turn.” — WORKS in terminal cleanup; AWKWARD on iPhone.** Daemon removes proven-absent session and its controls; torn/incomplete registry fails open (`src/daemon.ts:2662-2684`; `src/sessions.ts:253-262`). Inside iPhone, row becomes nil but stale composer can remain; Send then fails scoped validation and retains draft with little explanation (`mobile/conch-ios/conch-ios/SessionView.swift:39-45,140-224`; `src/daemon.ts:771-792,4735-4754`).

45. **“I open Settings just to look while another session is talking.” — AWKWARD in theater.** Opening Settings silently globally pauses/interrupts and closing may replay held work; the overlay never discloses that side effect (`src/daemon.ts:4492-4498`; `src/pause-controller.ts:86-103`; `src/status.ts:781-893`). Mac/iPhone settings do not have this daemon-audio side effect.

46. **“I open actions for an idle theater row while a different row is speaking.” — AWKWARD.** The same global pause lifecycle interrupts unrelated work before the target-specific menu appears (`src/daemon.ts:4563-4567`; `src/pause-controller.ts:86-103`).

47. **“I enter the visible phone relay URL in Settings.” — IMPOSSIBLE everywhere.** Mac renders unsupported kind; iPhone renders inert text; TUI has no string input handler (`mac-app/conch-mac/SettingsView.swift:375-416`; `mobile/conch-ios/conch-ios/SettingsView.swift:178-183`; `src/settings-overlay.ts:147-189`).

48. **“I use the footer bar's keys.” — BROKEN.** Every advertised key is raw-read and intentionally not dispatched; `q` and typed Ctrl-C also fail (`src/status.ts:1208-1214`; `src/daemon.ts:5186-5195`; `src/theater-controls.ts:44-45`).

49. **“I rename a terminal session with an accented/non-Latin name.” — IMPOSSIBLE in that editor.** It accepts only an ASCII safe-character set; Mac's text field does not impose that restriction (`src/session-actions-overlay.ts:84-85,209-214`; `mac-app/conch-mac/DashboardView.swift:855-870`).

50. **“I pair the phone by scanning a bad QR or with camera denied.” — AWKWARD/BROKEN feedback.** Non-relay QR does nothing; camera setup failure silently returns and the only exit is native sheet swipe (`mobile/conch-ios/conch-ios/PairingView.swift:248-294`).

51. **“I attach a file on Mac before typing, then another live session takes focus.” — BROKEN/wrong-recipient risk.** Typing's empty→nonempty transition pins the row, but attaching alone never calls `onDraftStarted`; attachments are unkeyed local state and Send targets the newly focused row (`mac-app/conch-mac/ComposerView.swift:41-64,195-203`; `mac-app/conch-mac/DashboardView.swift:1535-1568`).

52. **“I scroll up in a long Mac answer while it is still streaming.” — AWKWARD.** The source promises to follow only when already pinned, but `pinnedToBottom` starts true and is never changed by scrolling, so every last-item revision can yank the reader back down (`mac-app/conch-mac/ConversationStackView.swift:14-63`).

53. **“I quit the Mac app expecting Conch itself to stop.” — AWKWARD.** App-owned daemon stops; an adopted daemon is intentionally left running. The visible power row similarly becomes inert “started elsewhere” (`mac-app/conch-mac/ConchMacApp.swift:87-92`; `mac-app/conch-mac/DaemonHost.swift:106-125`; `mac-app/conch-mac/SettingsView.swift:593-608`).

54. **“I submit a bad Mac session name and correct it.” — BROKEN retry ergonomics.** Inline editor closes and discards its draft before daemon validation; rejection requires reopening and retyping (`mac-app/conch-mac/ContentView.swift:167-178`; `src/sessions.ts:128-133,201-218`).

## Part 4 — ranked common-sense violations

Rank combines severity, surprise, likelihood, and recoverability. The expectation is stated first; the code's actual behavior follows.

1. **Backgrounding and returning should preserve or restore the phone connection.** Actual: background permanently stops the cached transport; foreground and “Reconnect now” call a method that refuses stopped transports (`mobile/conch-ios/conch-ios/ConchApp.swift:74-130`; `mobile/conch-ios/conch-ios/DirectHTTPTransport.swift:33-60`; `mobile/conch-ios/conch-ios/RelayTransport.swift:276-302`).

2. **A backgrounded/locked app should not reopen its microphone.** Actual: a reading may finish in background and unconditionally fire a callback that opens recognition (`mobile/conch-ios/conch-ios/SpeechController.swift:287-329`; `mobile/conch-ios/conch-ios/SessionView.swift:230-239`).

3. **Leaving the screen with the only mic controls should close or visibly retain the mic.** Actual: iPhone Back clears only a speech callback; capture continues invisibly on the ledger (`mobile/conch-ios/conch-ios/SessionView.swift:163-201,230-241`; `mobile/conch-ios/conch-ios/ConchApp.swift:17-27`).

4. **A displayed shortcut bar should work.** Actual: footer intentionally disables every key while raw mode swallows them, including quit/Ctrl-C (`src/status.ts:1208-1214`; `src/daemon.ts:5186-5195`).

5. **Send should not erase an unacknowledged message.** Actual: Mac clears text and attachments immediately even if the socket send fails (`mac-app/conch-mac/ComposerView.swift:343-363`; `mac-app/conch-mac/StateStore.swift:116-130`).

6. **A visible Send button for an attached image should send it.** Actual: iPhone declares attachment-only sendable but controller silently refuses empty text (`mobile/conch-ios/conch-ios/SessionView.swift:519-522`; `mobile/conch-ios/conch-ios/TalkController.swift:203-212`).

7. **Radio/checkbox options should respond to taps.** Actual: iPhone deliberately draws them as inert HStacks; manual prose is required (`mobile/conch-ios/conch-ios/ConversationStack.swift:204-250`).

8. **A retired destructive feature should not remain reachable.** Actual: Mac `M`, TUI `m`, daemon protocol, persistence, rows, banners, docs, and tests still implement mute/forget. Mac's own comment says it is no longer offered while the key monitor still routes it (`mac-app/conch-mac/DashboardView.swift:373-378`; `mac-app/conch-mac/DashboardInputMonitor.swift:136-145`).

9. **One mode should not look Auto while behaving silent.** Actual: iPhone mode icon reads `paused` only; speech suppresses on `paused || muted`; there is no phone unmute (`mobile/conch-ios/conch-ios/LedgerView.swift:159-203`; `mobile/conch-ios/conch-ios/SpeechController.swift:64-91`).

10. **Opening a menu should not stop unrelated active work.** Actual: theater Settings and Session Actions both acquire a silent global pause/interrupt and may replay held work on close (`src/daemon.ts:4492-4498,4563-4567`; `src/pause-controller.ts:86-103`).

11. **A Stop-agent control should be available when the user is composing a correction.** Actual: any draft/attachment hides Stop on Mac and iPhone, forcing send or destructive discard (`mac-app/conch-mac/ComposerView.swift:123-149`; `mobile/conch-ios/conch-ios/SessionView.swift:416-485`).

12. **Documented shortcuts should keep working while using the app's primary composer.** Actual: editable focus kills Space, `P`, `M`, `R`, `?`, arrows, and Esc. Most have slower replacements; `M` has none in normal state (`mac-app/conch-mac/DashboardInputMonitor.swift:46-59,119-145`; `mac-app/conch-mac/ContentView.swift:336-346`).

13. **Changing sessions should not risk sending the prior session's draft to the new target.** Actual: Mac draft is view-local and composer is not keyed/per-session; only the target closure changes (`mac-app/conch-mac/ComposerView.swift:41-43`; `mac-app/conch-mac/DashboardView.swift:1535-1568`).

14. **Typing and dictation in one composer should be one draft.** Actual: Mac's displayed daemon dictation is excluded from composed text. On iPhone it is shared, but editing during a live partial can duplicate words (`mac-app/conch-mac/ComposerView.swift:173-185,343-354`; `mobile/conch-ios/conch-ios/TalkController.swift:140-173,227-243`).

15. **A hide/dismiss action should have adjacent restore everywhere it exists.** Actual: theater dismisses and couples forgetful mute, but cannot restore even though controller/daemon code exists (`src/session-actions-overlay.ts:29-82`; `src/daemon.ts:1125-1141,4544-4560`).

16. **A surface receiving dismissed-state data should expose it.** Actual: iPhone decoder drops `dismissed`/`dismissedRows`, making both dismiss and restore invisible (`src/panel.ts:361-365`; `mobile/conch-ios/conch-ios/Models.swift:147-170`).

17. **A starred artifact with a stored link should open.** Actual: TUI renders only the star/summary and Enter opens generic actions; no path reads the link (`src/panel.ts:31-45`; `src/status.ts:421-433`; `src/daemon.ts:5221-5228`).

18. **A local HTML preview should include its relative assets.** Actual: iPhone downloads one HTML file into a random temp directory; its comment about sibling access cannot be true for that transport (`mobile/conch-ios/conch-ios/DeliverableSheet.swift:132-140,232-248`; `mobile/conch-ios/conch-ios/DirectHTTPTransport.swift:89-96`).

19. **Unsupported/corrupt previews should offer recovery.** Actual: iPhone unsupported files have no Share/Open/Save/Quick Look, and corrupt PDF/video can present blank native views without errors (`mobile/conch-ios/conch-ios/DeliverableSheet.swift:119-147,251-284`).

20. **Two simultaneous completions should both join the phone's speech queue.** Actual: published conversations may contain both, but phone speech consumes one singular global reply (`mobile/conch-ios/conch-ios/SpeechController.swift:64-95`; `src/panel.ts:313-323`).

21. **Tapping Manual should make current phone speech quiet immediately.** Actual: iPhone awaits the network before `speech.stop`, so a dead/slow link lets audio continue behind the optimistic hand icon (`mobile/conch-ios/conch-ios/LedgerView.swift:159-183`).

22. **A mouse-enabled full-screen TUI should let a row click select the row.** Actual: clicks only clear text selection; arrows are mandatory (`src/status.ts:1101-1117`).

23. **Visible terminal text should be selectable consistently.** Actual: settled reply/log documents are selectable; the current speaking/dictation panes are not (`src/status.ts:695-768,1105-1122`).

24. **Urgent status should not disappear merely because a row is quiet.** Actual: theater precedence shows muted/paused before review/needs/waiting; Mac/iPhone deliberately do the opposite (`src/status.ts:409-427`; `mac-app/conch-mac/DashboardView.swift:1145-1176`; `mobile/conch-ios/conch-ios/Models.swift:176-247`).

25. **Every visible settings row should be editable unless marked locked.** Actual: `phone-relay-url` is impossible on all three surfaces (`src/settings.ts:300-309`; `mac-app/conch-mac/SettingsView.swift:375-416`; `mobile/conch-ios/conch-ios/SettingsView.swift:178-183`; `src/settings-overlay.ts:147-189`).

26. **A port control should move in whole numbers.** Actual: registry calls `phone-port` a number, so theater arrows move it by 0.1 (`src/settings.ts:289-298`; `src/settings-overlay.ts:184-188`).

27. **A recite-only action should not promise future recording.** Actual: theater speaking copy always says the mic opens when it finishes, while recite explicitly disables mic (`src/status.ts:695-701`; `src/daemon.ts:3283-3290`).

28. **A screen with a fixed chat composer should follow newly arriving content when already at the bottom.** Actual: iPhone creates a ScrollViewReader but never uses its proxy; the user must drag (`mobile/conch-ios/conch-ios/SessionView.swift:84-126`). Mac implements pinned-to-bottom behavior (`mac-app/conch-mac/ConversationStackView.swift:14-61`).

29. **Prepared attachments and text should have the same navigation durability.** Actual: iPhone text persists per session, while view-local photos vanish on Back without warning (`mobile/conch-ios/conch-ios/SessionView.swift:17-21`; `mobile/conch-ios/conch-ios/TalkController.swift:264-283`).

30. **A mode button's visible copy should match its implementation comment.** Actual: iPhone comment says a word labels Auto/Manual; only icons are visible, with words confined to accessibility (`mobile/conch-ios/conch-ios/LedgerView.swift:184-208`).

31. **A mic described as tap-to-send should still send, or the comment should change.** Actual: TalkController retains “tap to start, tap to send,” while live UI's second tap closes without send (`mobile/conch-ios/conch-ios/TalkController.swift:118-123,342-359`; `mobile/conch-ios/conch-ios/SessionView.swift:599-612`).

32. **Logs-on should show history, and logs-off should confirm.** Actual: theater starts an empty future-only buffer; it disables logs before emitting “logs off,” hiding the acknowledgement (`src/status.ts:1167-1170,1520-1527`; `src/daemon.ts:5255`).

33. **Mouse wheel should affect the region under the pointer.** Actual: theater discards coordinates and scrolls the pane even over ledger/header/footer (`src/daemon.ts:5202-5207`).

34. **Quit should remain quit inside a modal.** Actual: theater overlays trap `q`; only raw Ctrl-C falls through (`src/settings-overlay.ts:115-157`; `src/session-actions-overlay.ts:174-235`).

35. **Number shortcuts should show their numbers.** Actual: `1`–`9` wake sorted rows, but ledger has no indices; hidden `s` is needed to reveal mapping (`src/daemon.ts:5025-5077,5253-5254`).

36. **An editable name should accept ordinary names.** Actual: theater rename is safe-ASCII only, and arrow keys silently abandon an edit (`src/session-actions-overlay.ts:84-85,209-255`).

37. **A tool row that cannot expand should not look like the same button as one that can.** Actual: Mac/iPhone empty-result rows still accept a click/tap and silently return (`mac-app/conch-mac/ConversationStackView.swift:113-166`; `mobile/conch-ios/conch-ios/ConversationStack.swift:71-113`).

38. **A file-change filename should open the file or clearly label itself “expand excerpt.”** Actual: clicking only toggles a capped excerpt; there is no file/full-diff action (`mac-app/conch-mac/ConversationStackView.swift:297-356`; `mobile/conch-ios/conch-ios/ConversationStack.swift:123-183`).

39. **Reconnect should sit beside a disconnected error.** Actual: iPhone reconnecting/empty state has no button; retry is hidden in the laptop menu (`mobile/conch-ios/conch-ios/LedgerView.swift:84-121,216-254`).

40. **Camera/scanner failure should explain itself and offer Cancel/Settings.** Actual: setup silently returns, invalid QR silently does nothing, and only native swipe dismisses (`mobile/conch-ios/conch-ios/PairingView.swift:248-294`).

41. **One failed settings write should not replace every setting.** Actual: iPhone `loadError` swaps the entire list for a generic Try Again screen (`mobile/conch-ios/conch-ios/SettingsView.swift:20-37,114-117`).

42. **A stopped-turn request should show pending/success/failure.** Actual: iPhone ignores the Bool; the button can be tapped repeatedly until later state changes (`mobile/conch-ios/conch-ios/SessionView.swift:509-517`).

43. **A session disappearing while open should produce a clear closed state.** Actual: iPhone title/status/Stop vanish while the stale composer remains and only fails when Send reaches daemon validation (`mobile/conch-ios/conch-ios/SessionView.swift:39-45,140-224`; `src/daemon.ts:771-792`).

44. **Empty-state actions should fail visibly.** Actual: theater Space/Enter/r/number failures mostly write hidden logs; only hidden `s` forces visible empty copy (`src/daemon.ts:5025-5036,5064-5106`; `src/status.ts:1522-1527`).

45. **A setting overlay should let a user reset a saved override.** Actual: only Mac exposes reset. TUI/iPhone can set but not invoke the protocol's unset (`src/settings.ts:693-696`; `mac-app/conch-mac/SettingsView.swift:303-323`).

46. **Footer row identity should be stable by session id.** Actual: it intentionally matches live state by label, so duplicate labels can highlight the wrong/multiple row (`src/panel.ts:551-553`).

47. **Input should be parsed as a byte stream, not one entire “key.”** Actual: daemon compares the complete residue to one key, so coalesced ordinary controls can be ignored (`src/daemon.ts:5196-5264`).

48. **A QR/code pairing form should submit from keyboard Return.** Actual: neither iPhone pairing field has `onSubmit` (`mobile/conch-ios/conch-ios/PairingView.swift:220-227`).

49. **A long-press menu should either be reachable or removed.** Actual: iPhone's authored `YourTurnBubble` discard menu is dead code; the live composer exposes a one-tap unconfirmed trash instead (`mobile/conch-ios/conch-ios/SessionView.swift:416-432,637-667`).

50. **Source comments and product defaults should agree.** Actual examples: footer-era comment says theater is opt-in although full TTY defaults to theater (`src/status.ts:155-157,1219-1226`); iPhone background comments promise a stopped report over a bridge already stopped (`mobile/conch-ios/conch-ios/Info.plist:23-32`; `mobile/conch-ios/conch-ios/ConchApp.swift:127-130`); README calls `away-after` opt-in/off while registry defaults to 300 seconds (`README.md:166`; `src/settings.ts:261-275`).

51. **Attaching content should pin it to the same session just as typing does.** Actual: Mac only pins on first typed character; attachment-only state can follow live focus to another target (`mac-app/conch-mac/ComposerView.swift:41-64,195-203`).

52. **Scrolling up should disable automatic bottom-follow.** Actual: Mac's `pinnedToBottom` is never updated from scrolling, so streaming revisions can yank the reader down (`mac-app/conch-mac/ConversationStackView.swift:14-63`).

53. **Invalid rename should preserve the text for correction.** Actual: Mac closes the field before daemon validation and loses the draft (`mac-app/conch-mac/ContentView.swift:167-178`; `src/sessions.ts:128-133,201-218`).

54. **A visible pairing countdown should count down.** Actual: Mac computes expiry only on render and has no timer; it can freeze until another update (`mac-app/conch-mac/PairingView.swift:166-172`).

55. **Manual should communicate whether it applies globally or to one selected row.** Actual: on Mac the same header button silently changes scope with ledger selection; the person must choose All Sessions first for global behavior (`mac-app/conch-mac/ContentView.swift:210-244`; `mac-app/conch-mac/DashboardView.swift:2470-2559`).

56. **One Auto click should leave every quiet state.** Actual: if legacy mute and pause are both true, Mac shows Muted; the first click only unmutes and reveals Manual, and a second click resumes (`mac-app/conch-mac/DashboardView.swift:2510-2559`; `mac-app/conch-mac/ContentView.swift:210-260`).

57. **“Dismiss” should not be confusable with stopping a runaway session.** Actual: it hides the row, cancels/forgets Conch audio, and leaves the underlying agent running (`src/daemon.ts:4544-4560`).

58. **File drop should use the same validation and feedback as the picker.** Actual: Mac drop accepts any file URL/directory, reports acceptance before asynchronous decode, and gives no failure message (`mac-app/conch-mac/ComposerView.swift:158-170,365-384`).

59. **A missing artifact should offer recovery comparable to an unsupported existing file.** Actual: Mac missing-file state has no Reveal/Open/Retry, while unsupported files get Finder (`mac-app/conch-mac/ReviewView.swift:216-283`).

60. **A review card should explain why it cannot open.** Actual: a linkless Mac/iPhone review is disabled/has no expansion action without an adjacent reason (`mac-app/conch-mac/ReviewView.swift:30-46`; `mobile/conch-ios/conch-ios/SessionView.swift:670-698`).

61. **A background review notification should not seize the foreground.** Actual: Mac may order its window front and activate the app, subject to recent-use grace (`mac-app/conch-mac/ConchMacApp.swift:180-208,244-258`).

62. **Quitting the visible app should have a clear relationship to the daemon.** Actual: an app-owned daemon stops, an adopted daemon stays alive, and Settings cannot stop the adopted one (`mac-app/conch-mac/ConchMacApp.swift:87-92`; `mac-app/conch-mac/DaemonHost.swift:106-125`; `mac-app/conch-mac/SettingsView.swift:593-608`).

63. **The Settings gear should land on a predictable settings section.** Actual: it opens the Settings scene and relies on SwiftUI's current/default tab rather than explicitly selecting Phone app or Settings (`mac-app/conch-mac/DashboardView.swift:513-517`; `mac-app/conch-mac/ContentView.swift:20-22`).

64. **A missing CLI binary should offer a repair or chooser path.** Actual: Mac Start simply retries the same locate/launch operation and reports an error (`mac-app/conch-mac/DashboardView.swift:211-234`; `mac-app/conch-mac/DaemonHost.swift:51-104`).

65. **A displayed session voice/priority should have a nearby editing affordance.** Actual: Mac shows them read-only; setting priority/voice exists only in theater/CLI (`mac-app/conch-mac/SettingsView.swift:118-173`; `mac-app/conch-mac/ConchSocketClient.swift:85-106`; `src/session-actions-overlay.ts:292-395`).

66. **A pairing code should have an explicit Copy action.** Actual: Mac code/host text is display-selectable only; “New code” is the sole authored control (`mac-app/conch-mac/PairingView.swift:49-60,82-172`).

67. **A shared sending state should identify its target.** Actual: iPhone composer mic-disable/spinner conditions use global `talk.phase`, so navigating to another session can make that composer look as if it is sending too (`mobile/conch-ios/conch-ios/SessionView.swift:436-485`; `mobile/conch-ios/conch-ios/TalkController.swift:124-139`).

68. **An in-flight recognition hypothesis promised as crash-safe should actually persist.** Actual: only committed text writes UserDefaults; `partial` is volatile (`mobile/conch-ios/conch-ios/TalkController.swift:129-168,284-304`).

69. **A GIF preview should animate or say it is a still.** Actual: iPhone classifies GIF as image but downsampling produces one still frame (`mobile/conch-ios/conch-ios/DeliverableSheet.swift:34-36,286-333`; `mobile/conch-ios/conch-ios/ImageUpload.swift:22-31`).

70. **Successful pairing should not silently depend on an unchecked credential write.** Actual: Keychain add status is ignored, so the run can appear paired and relaunch unpaired (`mobile/conch-ios/conch-ios/BridgeClient.swift:478-487`).

71. **Malformed/newer state should surface in diagnostics.** Actual: iPhone silently drops a top-level decode failure while retaining connected/stale state (`mobile/conch-ios/conch-ios/BridgeClient.swift:78-91`).

72. **The expanded help should disclose all working keys and omit dead ones.** Actual: theater omits `s`, `1`–`9`, and `h`; `v` is absent from keybar; footer advertises controls that are all dead (`src/theater-controls.ts:41-65`; `src/status.ts:1208-1214`).

73. **Escape followed immediately by Space should not target a row just released.** Actual: `p/m` consult pending manual selection while Space/Enter/r can consult the last painted cursor, creating an async repaint race (`src/theater-navigation.ts:48-64`; `src/daemon.ts:5231-5247`).

74. **Enter should be accepted consistently.** Actual: top-level theater accepts CR only; overlays accept CR or LF (`src/daemon.ts:5221-5230`; `src/settings-overlay.ts:136-138`; `src/session-actions-overlay.ts:197`).

75. **A hidden/collapsed pane toggle should give immediate feedback.** Actual: `\` is accepted while logs/modal force the pane open, silently changing only the later layout (`src/status.ts:929-944`; `src/daemon.ts:5249-5252`).

76. **An environment-locked setting should be disabled, not merely rejected later.** Actual: Mac/iPhone disable it; theater still accepts editing gestures and relies on the settings endpoint's response (`mac-app/conch-mac/SettingsView.swift:294-332`; `mobile/conch-ios/conch-ios/SettingsView.swift:143-195`; `src/settings-overlay.ts:115-233`).

77. **Dismissing a session should not permit a hidden wake without restoration.** Actual: theater fallback can resolve unnamed wake back to dismissed `lastTurn`, and explicit wake overrides quiet gating (`src/daemon.ts:819-823,5144-5147,5231-5236`; `src/instant-controls.ts:240-266`).

78. **A connection replacement should offer recovery where it is reported.** Actual: iPhone relay correctly suppresses auto-reconnect, but the user must discover Reconnect in the laptop menu; the banner has no action (`mobile/conch-ios/conch-ios/RelayTransport.swift:919-940`; `mobile/conch-ios/conch-ios/LedgerView.swift:84-121`).

79. **Native background-audio declarations should match deliverable behavior.** Actual: the iPhone promises speech may finish and report stopped, but background already stops the bridge, so that report cannot reach the Mac (`mobile/conch-ios/conch-ios/Info.plist:23-32`; `mobile/conch-ios/conch-ios/ConchApp.swift:127-130`; `mobile/conch-ios/conch-ios/SpeechController.swift:287-300`).

80. **A reset/unset capability should be consistent across settings clients.** Actual: Mac exposes it; iPhone and theater omit it even though the protocol implements it (`mac-app/conch-mac/SettingsView.swift:303-323`; `src/settings.ts:693-696`).

## Mute-retirement audit

The retirement has reached only one entry point: the top-level CLI maps legacy `conch mute/unmute` to pause/resume (`src/cli.ts:404-424`). Everywhere below and beside that adapter, mute remains a separate, destructive, persistent mode whose defining difference is **forget instead of hold/replay** (`src/instant-controls.ts:54-78,132-170,216-271`; `src/pause-controller.ts:21,140,254,387`). It is not merely stale text.

### User-visible controls, strings, and tooltips

- **Mac:** live `M` mapping (`mac-app/conch-mac/DashboardInputMonitor.swift:8,142,176`; `mac-app/conch-mac/ContentView.swift:246-260,304-311`); shortcut sheet “M — Mute” and legend (“Muted — announcements dropped”) (`mac-app/conch-mac/ContentView.swift:336-346,431`); All sessions tooltip says pause, mute, and talk (`mac-app/conch-mac/DashboardView.swift:2504`); row status/labels and mode button show Muted, speaker slash, red tint, “FORGOTTEN” tooltip, and unmute action (`mac-app/conch-mac/DashboardView.swift:1115-1271,2510-2559`). This directly contradicts the nearby “Mute is no longer offered” comment (`mac-app/conch-mac/DashboardView.swift:373-378`).
- **iPhone:** rows still decode/display `muted`, speaker slash, “Muted,” and dim opacity (`mobile/conch-ios/conch-ios/Models.swift:19-29,107-141,176-247`; `mobile/conch-ios/conch-ios/LedgerView.swift:308`); SpeechController treats muted as passive and its header comment says it works while Mac is muted (`mobile/conch-ios/conch-ios/SpeechController.swift:11,66`); local videos start muted and comments explain mute semantics (`mobile/conch-ios/conch-ios/DeliverableSheet.swift:103-127`). There is no unmute control.
- **Theater/footer:** idle strings, row/header/banner glyphs and “m to unmute” remain (`src/status.ts:105-106,346,378-419,510`; `src/panel.ts:541-567`); both keybars, expanded help, and CLI help advertise `m mute`, mute/unmute, “m forgets,” and `conch mute` (`src/theater-controls.ts:41-63`). Raw `m` routes global/session toggles (`src/theater-controls.ts:16-38`; `src/daemon.ts:5162-5183,5258`).
- **CLI/MCP discrepancy:** CLI help still prints `conch mute | unmute`, but the command maps them safely to pause/resume (`src/cli.ts:48,404-424`). MCP description also calls mute/unmute “retired aliases,” yet its handler forwards the original action unchanged, invoking destructive daemon mute (`src/mcp.ts:178-189,649-666`). The comment and executable path disagree.

### Runtime model, protocol, and persistence remnants

- Published model and rows still carry mode/session mute (`src/panel.ts:4,26,42,147,342,379,429`; `mac-app/conch-mac/Models.swift:130-148,524-622`; `mobile/conch-ios/conch-ios/Models.swift:19-29,107-141`).
- Mac socket control types still include mute/unmute (`mac-app/conch-mac/ConchSocketClient.swift:5-16`). Hook/turn vocabulary and speech recognition command vocabulary still include both (`src/hook.ts:27`; `src/transcribe.ts:65`).
- Global and per-session implementations, arrival stamping, acknowledgements, and gate dispositions remain (`src/instant-controls.ts:7-78,132-190,216-271`).
- Daemon persists mute across restart, restores it, announces/logs it, routes control events, stamps/forgets queued arrivals, makes it win display precedence, and blocks voice audition (`src/daemon.ts:232-247,1349-1503,1544-1590,1811-1850,1913-1914,2418-2427,2589-2590,2710-2753,4947,5041-5054`).
- Dismiss is still explicitly coupled to session mute, and restore clears both (`src/session-actions-overlay.ts:29`; `src/daemon.ts:1133-1141,4544-4560`).
- Mac and iPhone artifact video code still starts playback silent when daemon mute is active (`mac-app/conch-mac/ReviewView.swift:179-208,619-639`; `mobile/conch-ios/conch-ios/DeliverableSheet.swift:103-127`).
- Other authored runtime references remain in away-mode guidance (`src/config.ts:57`), resume-digest ownership comments (`src/resume-digest.ts:33`), MCP public types/schema/default fixtures (`src/mcp.ts:39-82,179-185,376-387,649-666`), and the review harness's published-state fixture (`scripts/review-harness.sh:34-38`).

### Documentation and contract remnants

- README still teaches `conch mute/unmute`, global/session `m`, forget semantics, muted status/glyphs, and includes it in dashboard keybars (`README.md:134,166-174,192-197`).
- Mac's own README still says the app sends mute/unmute (`mac-app/README.md:5`).
- Plugin/control documentation still exposes mute/unmute and warns about its side effects (`docs/plugin-design.md:33,52`; `docs/conch-control-skill.md:41,77,84`; `docs/parity.md:27`; `plugin/plugins/conch/skills/conch-control/SKILL.md:46,82,89`).
- The backlog records the decision that mute should go, confirming the migration is intended but unfinished (`docs/backlog.md:13,25,36-37`).
- Tests make mute an enforced contract: global/session routing and keybar copy (`test/theater-controls.test.ts:90-109,123-180,317-325`); forget/persistence/arrival behavior (`test/instant-controls.test.ts:352-487,513-668`); footer/theater copy and precedence (`test/panel.test.ts:113-127,462-491`; `test/status.test.ts:104-163,509-545`); socket restore clearing dismiss-coupled mute (`test/socket-turn-controls.test.ts:138-148,460-467`).

### Exhaustive authored-file index for remaining `mute|muted|unmute` matches

A repository-wide case-insensitive scan, excluding generated build/dependency trees and this report, found matches in exactly these authored files. The substantive behavior is traced above; this index includes fixture/comment-only remnants so small references are not silently omitted.

- Product/UI/docs: `README.md` (`README.md:134,166-174,192-197`); `mac-app/README.md:5`; `docs/backlog.md:13,25,36-37`; `docs/conch-control-skill.md:41,77,84`; `docs/parity.md:27`; `docs/plugin-design.md:33,52`; `plugin/plugins/conch/skills/conch-control/SKILL.md:46,82,89`; `scripts/review-harness.sh:34-38`.
- Mac source: `ConchSocketClient.swift`, `ContentView.swift`, `DashboardInputMonitor.swift`, `DashboardView.swift`, `Models.swift`, and `ReviewView.swift` at the line groups in the preceding Mac/UI/runtime bullets.
- iPhone source: `DeliverableSheet.swift`, `LedgerView.swift`, `Models.swift`, and `SpeechController.swift` at the line groups in the preceding iPhone/UI/runtime bullets.
- Shared runtime: `src/cli.ts:48,404-424`; `src/config.ts:57`; `src/daemon.ts:232-247,578-594,805,863,892-893,995,1133-1140,1349,1401-1503,1544-1590,1811-1850,1913-1914,2418-2427,2589-2590,2710-2753,4544-4560,4947,5041-5054,5167-5183`; `src/hook.ts:27`; `src/instant-controls.ts:7-78,132-190,216-271`; `src/mcp.ts:39-82,179-185,376-387,649-666`; `src/panel.ts:4,26,42,147,342,379,429,545-567`; `src/pause-controller.ts:21,140,254,387`; `src/resume-digest.ts:33`; `src/session-actions-overlay.ts:29`; `src/status.ts:105-106,346,378-419,510`; `src/theater-controls.ts:4-63`; `src/transcribe.ts:65`.
- Tests enforcing behavior/copy: `test/daemon-config.test.ts:519,607-624,725,1222`; `test/dictation-flow.test.ts:191-194,231-310`; `test/instant-controls.test.ts:352-487,513-668`; `test/mcp.test.ts:412,502-566`; `test/panel.test.ts:113-127,462-491`; `test/settings.test.ts:381`; `test/socket-turn-controls.test.ts:138-148,460-467`; `test/status.test.ts:42-213,509-545`; `test/theater-controls.test.ts:90-109,123-180,317-325`.
- Tests with model fixtures or comments only: `test/daemon-boundaries.test.ts:27`; `test/phone-bridge.test.ts:528,581`; `test/publish-throttle.test.ts:51-59`; `test/sessions.test.ts:93-95`; `test/status-publish.test.ts:21-29`.

### Retirement conclusion

The current code has three incompatible answers:

1. Mac visually presents Auto/Manual and claims mute is no longer offered, but retains a hidden destructive `M`, visible help/legend/status, and conditional header unmute.
2. iPhone offers only Auto/Manual, yet still obeys mute and can become unrecoverably Auto-looking-but-silent.
3. TUI openly presents pause and mute as separate first-class controls and its tests require that distinction.

Retiring mute therefore requires more than deleting copy: remove/translate protocol events and persisted state, decide how dismissed sessions stay quiet without forgetful mute coupling, migrate stale persisted mute to pause/manual or auto, remove `M`/`m` routing and tests/docs, and eliminate muted-specific rendering/video behavior. Until that migration exists, calling mute “retired” is factually incorrect.

## Verification notes

- Focused terminal suites covering renderer, input, overlays, pause/mute, session actions, socket controls, and publishing passed: 222 tests, 0 failures.
- The iPhone project has one app target and no test target (`mobile/conch-ios/conch-ios.xcodeproj/project.pbxproj:114-131,159-161,176-202`), so iPhone findings are source-path verification rather than automated UI-test claims.
- Mac failures called “at risk” where they depend on SwiftUI structural state identity (the cross-session composer draft) are explicitly marked as such; hard failures—shortcut gating, unacknowledged clear, mute routing—follow direct imperative paths.
- `git status` was clean before the audit. This report is the only repository file created.
