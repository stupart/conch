# conch roadmap

**This is the master.** Everything open lives here. If it is not in this file
it is not tracked, and that is the point — there were seventeen documents and
Tyler could not tell whether an idea had survived being written down.

The rest of `docs/` is now reference, not planning:

- `architecture.md` — how the system actually works, and what is wrong with it
- `daemon-side-effects.md` — everything the daemon does outside conch's own
  files and processes, and whether the app would be a better home for it (A17)
- `vision.md` — the feed, and why it comes last
- `marketplace-vision.md` — the discovery/marketplace idea in full (item C3)
- `surfaces.md` — the 18-entity study of what conch must account for
- `palette-plan.md` — the implementation plan for plugins/skills/MCP
- `conch-control-skill.md` — the agent-facing contract that ships in the plugin
- `archive/` — superseded planning docs, kept for their history: the old
  backlog with its full Fixed list, the UI audit, the t3code parity study, the
  phase audit, and the palette build log

## Everything left, and where it lands

Written 2026-08-20 at Tyler's request: *"list out the things we want to add and
fixes we want to make and then we can decide where to draw the line to commit
and refac before proceeding."*

Every item is verified against source, not against older lists — that check has
gone wrong twice, and half of `backlog.md`'s Features section is stale because
of it. The right-hand column is the point: it says which part of the system
each item lands in, so the refactor can be shaped by what is coming rather than
only by what exists.

## The four seams

`daemon.ts` is 5,213 lines (it was 4,954 after cut three; the C9b holder wiring landed in it). `docs/architecture.md` names where it splits:

- **Q** `event-queue.ts` — extracted: pending events, drain, command barriers,
  cancellation bookkeeping, and audition exclusion; intake stays in the daemon
- **V** `voice-loop.ts` — wake → speak → listen → deliver
- **C** `control-server.ts` — extracted: framing, validation, dispatch, replies,
  lifecycle, and the reserved C9b owner envelope; device effects stay in the daemon
- **R** `session-registry.ts` — reconciling Claude's registry with Codex's DBs
- **UI** — the two apps and the TUI; no daemon change at all

---

## A. Bugs — things that are wrong now

| | fix | lands in |
|---|---|---|
| A1 | ~~**The artifact is hard to find, and the two apps disagree about it.**~~ — **done** (2026-08-20, `6baf30b` + `39c3b86`). Both apps default to the conversation and carry the artifact inline where it happened; on Mac, opening it switches the top tab, and on the phone — which has no tabs — it goes big as a sheet. Design as Tyler settled it, below. | UI |
| A2 | ~~**The Mac app does not respawn a dead daemon**, and hides the start toggle when it happens.~~ — **done**. Respawn (2026-09-10): an adopted daemon's socket is polled every 3 s and the app starts its own when it stops answering. The rest (2026-09-11): the daemon writes `daemon-identity.ts` once it owns the socket and clears it on shutdown; the app reads the file when it adopts and says "started by the launchd service" / "started from a terminal (pid N)"; the switch stays, disabled, with "the app can't stop what it didn't start" beside it instead of vanishing. | C |
| A3 | ~~**Two ways to run the daemon** — launchd/tmux and the app. Two owners is the root of A2.~~ — **done** (2026-09-11). #138 stopped `conch setup` installing the agent beside the app; the plist now names launchd as owner (`CONCH_STARTED_BY`), and when the app adopts a launchd daemon the settings row offers "Let the app own it" — `conch service off` (bootout by label, plist removed; never a kill by pattern), wait for the socket to go quiet, then the app's own `start()`. | C |
| A4 | ~~Multi-select by voice returns one option~~ — **fixed**. It was already returning sets after the parity pass, so this entry was stale; what was missing was "all of them", which is how people actually answer one out loud. | V |
| A7 | ~~**A session id is not a window, and conch assumes it is.**~~ — **fixed**. `claude --resume <id>` in a second terminal keeps the id, so Tyler works in two windows (`~/arch-website`, `~/arch-swap`) sharing `4eb30ede`. A shared id is now keyed per window (`<id>#<pid>`, `window-key.ts`), which makes every map the daemon keys by id per-window with no other change; hooks are attributed by walking the process tree to the window that ran them, since Claude Code's payload names only the session; ids from outside are translated at the socket door; transcript and label lookups strip back to the session. Both rows now show, each with its own name, status and route. | C |
| A8 | **The conversation pane cannot tell the two windows apart.** Both read one transcript, so a window shows whatever branch was written last — visible as `arch site` displaying arch-swap's work. Claude Code chains messages by `parentUuid`, so the branches themselves separate exactly; what is missing is which branch belongs to which window. Two exact signals exist and are worth trying before any heuristic: the registry entry carries a `bridgeSessionId` whose suffix matches `bridge-session` records in the transcript (both windows write them — 7 and 240 in Tyler's file), and each window's chain has its own leaf. Do NOT map by cwd or recency; a confidently wrong conversation is worse than a shared one. | C |
| A5 | **The relay drops every 100 minutes, exactly.** Five 1006s, evenly spaced. Unexplained; separate from the idle bug fixed on 08-18. | C |
| A6 | **Mac audio degraded** — `say` timed out at 18s, Kokoro hard-restarts. Tracks machine memory; recheck now the Mac is healthy. **Rechecked 2026-09-10 on the M5 Max: zero timeouts or restarts in a full day's log.** Leave open until it recurs; it was the old machine. | V |
| A7 | ~~**Duplicate terminal mouse-up?**~~ Repeated `copied N chars` with nobody selecting. **Solved 2026-09-10, the moment the line carried a pid and a time:** the writer was the TEST SUITE — `test/status.test.ts` drives three fixture selections through the theater's `copySelection`, whose `logAbove` appended to the live `/tmp/conch-daemon.log` (with UTC timestamps, because bun test runs in UTC); ~30 suite runs a day made ~90 lines. The clipboard was never touched (the tests stub `copy`). Fix: `LOG_FILE` honours `CONCH_LOG_FILE`, and a bun test preload points it at a temp file for the whole suite. Earlier analysis below kept for the record. Ninety copies that day, always the same three sizes in the same order (94, 5, 709), while Tyler was away. Facts: the line is written by `copySelection` in the theater, which only runs on a mouse-up after a real drag (`TheaterSelection.end` clears a click without movement), and pointer events come only from a TTY stdin — so the writer is a `conch` TUI in a terminal, never the app-spawned daemon, which has no TTY. Each copy also runs `pbcopy`, so whatever this is clobbers the clipboard every time. The log line now carries a timestamp and the writer's pid; the next occurrence can be matched to what happened. Suspects: something replaying the same three drags into a theater pane (tmux, a terminal restore after sleep, or a raised window). | UI |
| A8 | ~~**A Mac draft can be lost on an unacknowledged send.**~~ — **fixed** (2026-09-10): the app clears its draft when the daemon ACCEPTS a send, which is before anything is typed, so an inject that was then interrupted or fell back to the clipboard had erased the only copy on screen. The daemon now hands undelivered text back through the dictation channel (`publishDictation`, applied once by id to that session's composer), on both the interrupted and the clipboard paths. The phone's composer for the same session receives it too; that is the channel's existing scope. | UI |
| A9 | ~~**An image-only send does nothing on the phone.**~~ — **already fixed** in `SessionView.sendDraft`: a picture with no words goes direct instead of through the controller, which rightly refuses an empty draft. Row was stale. | UI |
| A10 | ~~**The terminal never consumes the artifact link it is sent.**~~ — **fixed** (2026-09-10). It rendered `review.summary` and `review.at` but never read `review.link` (`status.ts` had no reference to it), and no key opened anything — the only `open` was `review_to_front` spawning it once from the session's own MCP process (`mcp.ts:873`), which a marker-filed review never got. Now the link rides on the row and sits inline above the parked pane, **o** hands it to macOS `open`, and the row calms to waiting with the summary kept, keyed on session + review time like the Mac's `seenReviewIDs` (`ConchMacApp.swift:181`) so a newer review re-arms it. Local to the terminal and never published — the Mac keeps its own the same way. | UI |
| A13 | **Clicking a doc link in the Mac app's conversation errored.** Reported 2026-09-10 in the asset generator session; the error text was not captured, so this is filed as a symptom, not a diagnosis. Distinct from A10 (the terminal never consuming the artifact link) — this is the app's own link handling in the conversation pane. First step next time it happens: read the exact error before touching anything. | UI |
| A14 | **Two things the split recon found and did not fix.** (1) The "inject and interrupt are silent" story is too strong: delivery failures and interrupt failures can call `speak`, and delivery passes through voice Q&A (`daemon.ts` around 2636/3152/3237/4652). (2) Immediate `handle` calls — the inject/interrupt path that skips the drain — reset the shared `stopKey` and `micOpen`; that is a concurrency seam worth a behavioural test of its own, not something to fix inside an extraction. Both are Codex's findings; the frame-cap ordering it also found is fixed. | C |
| A15 | **A fresh install's pairing tab is a dead end.** `phone` defaults off and `phone-relay-url` defaults empty, so the first thing a new machine shows under Phone app is an error — and the tab reported the daemon's `session-error` as "Could not read the daemon's pairing reply" because it decoded only the pairing shape (2026-09-10, the new laptop; the QR needs the relay, the relay needs the URL, and the URL lived only on the old Mac's settings). **Fixed** in part: the tab now shows the daemon's refusal verbatim, and the refusal and the no-relay copy name the setting, the tab that exists, and the exact `conch set` command. **Open, Tyler's call:** ship `https://conch-relay.tylerstupart.workers.dev` as the built-in default so the QR appears with no setup at all — every install would then route through one Cloudflare account (rooms are secret-keyed, the relay sees only encrypted bytes, but the traffic and the bill are his), or keep bring-your-own-relay and make `phone` default on. | UI |
| A16 | ~~**An oversized socket frame can still be dispatched after the connection is destroyed.**~~ — **fixed**: the EOF handler returns on a destroyed socket, and the cap test now asserts the refused frame never reaches the application. On Bun 1.4.0 `sock.destroy()` on the 64 KB cap can still emit `end` with `sock.destroyed === true`; the EOF handler's `handled` flag is still false, so it parses and dispatches the buffered JSON while the client gets no bytes. Codex reproduced it against the ORIGINAL handler with a 64,001-character `get-config` padded with spaces — a parseable oversized mutation could reach application logic unacknowledged. Cut three preserved the behaviour deliberately (extraction, not fix). Fix: the EOF handler returns when `sock.destroyed`, with an executable test over a real socket. | C |
| A11 | ~~**A closed session can keep its pass through manual mode.**~~ — **fixed**: `resumedSessionIds` is one of the collections `forgetGone` prunes, and the ledger test flips from pinning the leak to pinning the prune. `resumedSessionIds` is deleted inside the render prune, but it is not one of the eight collections `trackedIds` is built from, so an id living only there is never iterated and never pruned. It matters more than its size: membership is checked BEFORE the global pause gate (`instant-controls.ts:188`), so that a session resumed by name speaks while everything else stays held — a stale entry is a closed session that can speak through manual mode. Usually pruned via `sessionStates`/`latestTurnBySession`; the gap is when it is not. Fix: add it to `trackedIds`. Found by Codex during the ledger recon; `SessionLedger` pins today's behaviour in a test, so the fix shows up as a deliberate flip. | C |
| A12 | ~~**`reportedMissingCodexPid` never forgets a closed session.**~~ — **fixed**: the set is now a `SessionLedger` collection, so `forget` clears it and `forgetGone` prunes an id living only there; the daemon destructures it from the ledger instead of keeping its own. Only cleared for a session still being rendered WITH a pid (`daemon.ts:1287`), so a Codex session that closes pid-less stays for the daemon's lifetime; `closeLiveSession` can also add on a failed close. Unbounded but tiny, and the only behavioural risk is a suppressed warning on id reuse. Fix: delete it in `SessionLedger.forget`. | C |
| A17 | **The daemon types into other windows, and the setting that gates it is dead.** Audited 2026-09-11 (`docs/daemon-side-effects.md`) after Tyler asked whether daemon rules were "globally affecting stuff on the computer". Nothing closes or takes over the mic or speakers for other apps — macOS shares both — but three things reach outside conch and are wrong as they stand: (1) `keystroke-fallback` defaults to false yet the app (`DaemonHost.swift:92`) and the launchd plist (`install.ts:635`) export `CONCH_KEYSTROKE_FALLBACK=1`, and env beats the file (`settings.ts:647`), so it is on in every real install and `conch set` cannot turn it off; the focused route then activates Terminal and types your whole utterance into the frontmost window with no check that it is still the right one (`inject.ts:125`), and the blind route (`inject.ts:156`) types into *any* app when the turn has no pid. (2) `conch_mode resume` and `conch_speak` carry no `origin`, so any agent can re-enable the voice you silenced (`mcp.ts:658-680`). (3) `reveal-on-turn` is on by default and raises a Terminal window on every announced turn, including during a screen share. The verdict on "move it into the app": no — the app is already the TCC responsible process and macOS has no audio isolation to offer; the app's contribution is a pre-typing focus guard and honest permission state. **First three changes if agreed:** delete the blind route and make the fallback a real setting with a frontmost-window check before every keystroke (+ `NSAppleEventsUsageDescription`); `origin: "agent"` on `conch_mode`/`conch_speak` so manual mode holds them like `conch_wake`, and widen `meeting-autopause` to every input device; `reveal-on-turn` off by default, `chmod 600` on `/tmp/conch-hook.log`, `CONCH_LOG_FILE` honoured by the inject debug log (the test suite writes ghosts into it), and a reaper for an orphaned `sox -d` in the D3 pattern. | V + UI |

### A1 in detail — the artifact, as Tyler designed it

> we have 2 tabs (artifact and conversation) on mac app that are nice - we
> could just remove the banner thing prob and have it default to showing
> artifact/deliverable tab when there is one? or maybe it defaults to
> conversation but shows the artifact/deliverable preview inline and then you
> click or tap on it and it goes gets big and the top tab changes to artifact /
> deliverable. I think thats the move. that way you're not annoyed always
> switching back if u just want to chat but the artifact content is front and
> centre and easy to focus on entirely if u want.

Where the two apps actually are:

- **Mac** has the tabs — which Tyler likes — and currently defaults to the
  artifact whenever one exists (`DashboardView.swift:1493`, `showsConversation`
  starts false). This is not wrong, it is the thing being refined: *"I like what
  the Mac app does but think it can be a bit better."* The refinement is where
  you LAND, not whether the tabs should exist.
- **Phone** has no tabs at all — a banner card inside the scroll, above the
  conversation, opening a modal sheet. Since sessions now open at the bottom,
  that banner is never on screen.

The settled design, for both:

1. **Default to the conversation.** Chatting is the common case, and the
   annoyance he names is having to switch back when he only wanted to talk.
   The tabs stay — they are the good part.
2. **The artifact appears INLINE, where it happened**, as a preview with real
   content rather than a link or a filename.
3. **Tap or click it and it goes big**, with the top tab switching to
   artifact — so the same gesture both focuses it and explains where it went.

Note what this is: `vision.md` item 11, "artifacts inline where they happen",
arriving early because Tyler chose it as the stepping stone. His words: *"in
the future we can still do the social media style UI/UX innovation but this
feels like a good middle stepping stone."* Build it as an inline ITEM rather
than a pane, and the feed later becomes a lens over it rather than a rewrite.

### A11 — a session can start and then sit on a prompt

Tyler, resuming a Codex session: *"it got caught on a system message so we
might need to adapt for those - this is with codex."*

conch launched it and called that done. The process was alive and waiting the
whole time (`codex --dangerously-bypass-approvals-and-sandbox resume <id>`,
pid confirmed running, thread never updated after launch).

Codex has several startup prompts that block on a keypress, including
`"Backup folder: unavailable / Continuing startup with a fresh local
database... / Press Enter to continue."` and a model-change confirmation when
a thread's recorded model differs from the current default. Claude Code has the
trust dialog, already handled by reading `hasTrustDialogAccepted` before
launching.

**Fixed generally rather than per-prompt**: starting now waits for the session
to appear in the ledger, and says so when it does not. Chasing each prompt
would mean a new special case every time either agent adds one; "did it
actually come up" is the same question for all of them, on both agents.

Still worth doing separately (not blocking):

- Read Codex's `projects.<path>.trust_level` before launching, the way the
  Claude trust check already works, so an untrusted directory is named BEFORE
  the session is started rather than after it fails to appear.

## B. Parity — catching up with the two agents

| | add | lands in |
|---|---|---|
| B1 | ~~**Per-kind metadata in the inspector**~~ — **done**. Transport and endpoint, plugin version and marketplace, skill visibility and who may invoke it, tool approval mode: a summary line on every row, the full set in the expanded detail. The readers already carried it; the Swift model was discarding it, which is why two `context7` servers read identically when one runs a local binary and the other reaches a remote host. | UI |
| B2 | ~~**Change the model mid-session.**~~ — **done**. A `set-model` session command the daemon delivers as a typed `/model <model>` through the same `injectText` route as the `/rename` sync (`conch model <session> <model>`, and a Model row with a field in the Mac inspector); no effort argument, because the installed Codex's `/model` is a picker with no argument form. | V + UI |
| B3 | **The write pass** — toggle plugins, skills, MCP servers, and per-tool permissions. Needs diff preview, scope, atomic write, readback, rollback, and the "next session" label. | C |
| B4 | ~~**The slash-command palette**~~ — **done** (2026-09-11). ⌘K (a Session menu item and a header button) opens a fuzzy-searchable list for the selected session: conch (pause/resume, wake, recite, stop, reveal, rename…, model…), session (dismiss, restore each dismissed row, inspect, help session), the agent's slash commands as documented for Claude Code or Codex, and its user-invocable skills from the existing `agent-capabilities` read (`/plugin:skill` for Claude, `$name` for Codex) — every row says what it will do, and a declared argument is asked for first. Typed rows go through the composer's `inject`; the one daemon change is that a slash line now takes B2's `injectProviderCommand` door instead of the message route (which matched it against pending questions, offered it to voice Q&A, honoured auto-submit off, and re-pressed Return into the picker a bare `/model` opens). Not listed: MCP prompts (the read has no prompt catalog — that needs a live MCP client, `palette-plan.md`'s "owned host protocol") and the session's exact command set (the lists are the documented ones; its version has the final say, and the palette says so). | C + UI |
| B5 | **Approvals** (the four-way decision) and **checkpoint/revert**. Both blocked on ten seconds with permissions on. | V |
| B6 | **Errors that find us** — step 3 of the error work: an agent watches the structured log and investigates unprompted. | C |
| B7 | ~~**Phone: a working folder for fresh sessions.**~~ — **done** (2026-09-10): the New session sheet's working folder is remembered per phone (last used, plus five recents in UserDefaults, offered as rows under the field), sent as `cwd`, and the sheet says where the session lands — blank means the Mac home folder; a daemon refusal ("session directory does not exist") is shown in the daemon's words, and Codex's trust question is asked on the phone with its own options, as on the Mac. In scope: typing a path or tapping a recent. Not in scope: no folder browser over the wire — that is the next slice if typing proves too much. The image-only half was already done (A9). | UI |

## C. Beyond parity — what conch can do that neither agent can

| | add | lands in |
|---|---|---|
| C1 | **Configuration at session START.** The only moment a toggle is honest. Turns B3's hard problem into a non-problem. | C |
| C2 | **Agents messaging each other through conch.** conch owns delivery, addressing and every transcript; agents cannot reach any of it. Needs a real answer on loops and consent first. **Shelved context (2026-09-10):** Tyler's cross-LLM memory layer — one index of conversation history across Claude and ChatGPT, exposed as a tool so models can find prior context — is parked until conch is done. The expectation is that building conch produces its primitive anyway: an index of conversations and content that agents can search, plus this item, agents reaching each other. Design that index with receipts — every result cites the conversation and turn it came from — because that is the property the eventual product is built on. | Q + C |
| C3 | **Discovery and the unified marketplace** — skills, plugins, marketplaces, MCP servers, and possibly workflows/loops/prompt templates. The last three are the scope trap. | C + UI |
| C4 | ~~**Subagents nested under their session**, folder-style, plus a way to reach one from the conversation.~~ — **done** (2026-09-11), narrowed to what Claude Code writes to disk. A subagent has NO registry entry (it runs inside the parent's process) and fires `SubagentStop`, never `Stop`; conch registers only Stop/Notification/UserPromptSubmit and `hook.ts` drops SubagentStop before the Stop path, now pinned by an executable test that spawns the hook. What exists on disk: a sidechain transcript under `<project>/<sessionId>/subagents/agent-<id>.jsonl` (+ `.meta.json` with the description), the parent's tool_result carrying `toolUseResult.agentId`, and a `<task-notification>` when it reports back. So: a **live background agent** (launched, not yet reported, sidechain fresh — the same reader the Stop-reclassification already used) is a row with `parentSessionId`, nested under its parent, oldest first, never active, never announced, no composer, no close; its transcript is the sidechain, read by the ordinary conversation reader. From the conversation, a Task/Agent block that named its agent gets an open control: the live row when there is one, else a row built from the block that reads the sidechain's last reply; a back chevron on the nested pane returns to the parent. **Not shown:** finished agents as rows (nothing on disk says "finished" except the parent's notification, and their results are already in the parent), and a synchronous Agent while it runs (its tool_result lands only at completion, so the parent transcript has nothing that names it yet). No nesting from label prefixes or timing. | R + UI |
| C5 | **Make the plugin genuinely useful**, and review it in detail. It is the one surface agents read, so it decides whether any of the above gets used. Includes the `review_to_front` rename and documenting the contract. | plugin |
| C6 | **Phase 3, the feed.** Deliberately last, and a VIEW over what exists. | UI |
| C7 | ~~**A conch session that ships with conch**~~ — **done (2026-09-11)**, the smallest honest version. **What exists:** `conch help-session` and a third mode in the Mac app's New session sheet, **Help with conch** (Claude only), both sending the ordinary `session-start` into `~/.config/conch/help/` — a folder conch creates on demand, with a `CLAUDE.md` conch writes from `docs/help-session/CLAUDE.md` on every start (what conch is, the surfaces, where settings, `errors.jsonl`, the daemon log and the published state live on this Mac, the rules: read the log before guessing, never kill the daemon by pattern, the app owns the daemon, ask before changing settings, and the install-map problems: silent mic → app entitlement, pairing-tab error → `phone` off, no QR → `phone-relay-url`). The ledger shows it as **conch help** (pinned by folder in `sessionLabel`, under a `conch rename`); its power is the plugin's nine tools and the CLI, nothing new; a test cross-checks every command, tool, file and setting the doc names against source. **Deliberately left:** starting it on launch — a Claude session costs money and attention, so it stays one click or one command away; the phone; any privileged control beyond what a Claude session in that folder already has; and the diagnostic *tools* this row asked for — the session reads `/tmp/conch-daemon.log` and `/tmp/conch-sessions.json` directly, which is what the 08-30 diagnosis needed. | plugin + C |
| C8 | ~~**Teleport by ID beside local Resume.**~~ — **done (2026-09-10)**. Mac and iOS offer **Teleport by ID…**, Claude only, with a cloud session id and a required working folder on the Mac. The launch is `cd -- '<cwd>' && exec claude --teleport '<id>'`; the wire preserves `teleportSessionId`, rejects malformed/flag-shaped ids, rejects combining it with `resumeSessionId`, and answers Codex with "Codex has no teleport". `session-started` carries `teleported: true` only for this path: it means **opened in Terminal**, not completed authentication, download or checkout. Both pickers say that this creates a local copy, new work does not update the original Claude app session, internet and the same Claude.ai account are required, and Claude may switch Git branches and ask to stash local changes, including untracked files. **Verified recon:** no supported non-interactive cloud listing exists; a private `/v1/code/sessions` endpoint exists and was **not called**. Arrival has a textual fork warning but **no structured parent id**. **Codex 0.153.4 has nothing teleport-shaped**; remote-control pairing and cloud tasks are different operations. Resume continues to read local history. conch promises **no cloud discovery, workspace restoration, or joining a live session**. **Declined:** the historical-fork provenance scan (streaming transcripts for the arrival warning): fragile text matching tied to an implementation detail of one Claude Code version, unnecessary for this cut. | C + UI |
| C9 | **More than one conch.** A second laptop works, and the two are simply blind to each other: separate daemon, socket, registry (each reads its own machine's `~/.claude/sessions`) and TTS. The "two daemons fight over one socket and one mic" hazard is within a machine, not across. The collision is the phone: pairing is per-machine (`~/.config/conch/relay-pairing.json`, its own room id and secret) and the iOS app stores exactly ONE — `PairingStore.save` calls `delete()` first and writes a single fixed Keychain account (`BridgeClient.swift:742`). So pairing a new laptop UNPAIRS the old one, silently, which is the first thing anyone with two machines will hit and should at minimum say so. Cheapest first: (1) the phone holds N pairings and switches — a list where there is now a scalar; (2) both machines' sessions in one ledger, since the relay already carries what that needs; (3) one conch primary and the other relaying into it, only if (2) shows it is wanted. Start at (1); do not build (3) on speculation. | C + UI |
| C9b | **One conch across two Macs, with a holder.** Tyler's, and it lands on something conch already has: `AudioSinkLease` (`daemon.ts:721`) is already a one-holder-at-a-time arbiter — it just has exactly two hardcoded values, `mac` and `phone`. The handoff model is that lease generalized to N devices, not a new concept. His sketch: the machine not in use shows a dimmed window saying conch is being controlled elsewhere, with a button to take it. **The constraint that shapes everything: sessions are machine-local.** A session is a process with a tty and a transcript on ONE Mac, so a second Mac can never run it — it can only see and drive it, which is exactly what the phone already does over the relay. So this is not merging two daemons; it is a second Mac joining as a relay client that happens to also be a host for its own sessions. The interesting question, and the reason this belongs in the refactor rather than after it: whether the ledger is per-daemon with a client view stitched on, or whether a device holds a lease over a merged view. Decide the seam while `daemon.ts` is being split, because retrofitting arbitration into thirty-seven closures is how this becomes a rewrite. **Decided 2026-09-10 (Codex recon, verified): the ledger stays authoritative per daemon; a second Mac's sessions are stitched in at the client as owner-tagged rows, `{ownerDeviceId, localSessionKey}`, with the local key preserved exactly (including the conditional `#pid`). Never merge remote sessions into a local ledger — a complete local registry scan calls `forgetGone`, which would delete their runtime state. Route to the owner first; that daemon does its own window resolution and delivery, as the phone already does. `AudioSinkLease` is a local sink selector, not a lease: no holder identity, no generation, two daemons make two of them — a shared audio coordinator needs an identified holder, liveness, and stale-ownership rejection. This constrains session-registry's completeness contract, control-server's owner routing, published-state identity, and voice-loop's audio arbitration; it does NOT need a distributed queue. **Recon follow-through:** relay rooms have two roles with evict-before-accept: a second Mac joining the phone’s room evicts the phone. The relay path needs one room per client pairing and a collection of daemon relay handles. Identity is a daemon-minted file, not a setting or relay room. A real audio holder needs an authority, grant revision, identified holder and expiry; none exists today. **Cuts:** A — see the other Mac’s rows and send typed text, over LAN first; B — the holder and Take-it UI; C — dictate on A into B. **A0 done (2026-09-10):** persistent `device-id` in the settings config directory; the daemon loads it before publication/control and publishes `ownerDeviceId` on every complete document. Mac and iOS decode it with an empty default for older daemons. No device name, remote transport, stitching or holder behavior in this slice.<br>**A1 done (2026-09-10):** B pairs with multiple Macs over LAN, keeps each owner’s document separate, groups and tags remote rows by host/owner, reads remote conversations and files, and sends owner-enveloped typed text with acceptance/refusal feedback; observer subscriptions leave phone audio presence unchanged.<br>**A1 exclusions:** no remote attachments, mic/dictation, reveal, audio changes on either Mac, relay transport (A2), device names, or phone app changes.<br>**B done (2026-09-10):** one identified holder per daemon (`src/audio-holder.ts`: revision so stale claims lose, 90 s lease so a vanished holder cannot mute a Mac, expiry back to local without a bump); Take it on A stops B synchronously (the phone-claim sequence), B's turn announcements and recites are presented on A through `speak()` at most once, B's window dims exactly the mic and auto/manual with "Controlled by <host> — Take it", A shows "You hold audio · <host> is silent"; the phone still wins on its own daemon. Built and tested on one Mac only — the two-Mac flow is not yet exercised end to end.<br>**B leaves:** Cut C (dictate on A into B), A2 (relay path), device names (hosts show as host:port), and the phone interaction exactly as documented: a phone claim on a yielded daemon takes that daemon's audio and its announcements stop travelling until the phone leaves. | C |
| C10 | ~~**Click a session's title to bring its window to the front.**~~ — **done**: a `reveal` session command (fire-and-forget; the ack says whether there was a process to try) and the conversation pane's title is a button only for rows the daemon publishes as `revealable` (it knows the pid). Limits stand as written below: Terminal.app by tty, so iTerm2, no-tty and observed-only sessions get a plain title. Mostly plumbing that exists: `revealSessionWindow(pid)` (`inject.ts:300`) already raises a session's Terminal tab and `revealOnTurn` already calls it. The work is a socket command addressed by session id and a tap target on the title in the Mac app. Know the limits before promising it: it drives Terminal.app by AppleScript and matches on tty, so an iTerm2 session, a session with no tty (`??`), or one conch only observes has nothing to raise — the title should not look clickable when it is not. Pairs with the click NOT stealing focus for a session that is merely being read, which is why `revealOnTurn` surfaces without focusing. | C + UI |
| C11 | **A cloud/local toggle for speech.** Today both ends are local: whisper.cpp transcribes and Kokoro (falling back to `say`) speaks. That is the right default and should stay the default, but it is also the single biggest source of the failures Tyler actually hits — `whisper-server request-failed` lost a whole utterance on 08-30, TTS fell back to `say` in the same minute and delayed the mic by five seconds, and Low Power Mode throttling is already recorded as the real transcription killer. A hosted STT/TTS mode fixes all three at the cost of latency, keys, and privacy. Privacy is the design constraint, not a footnote: cloud mode means the user's AUDIO leaves the machine, so it must be an explicit switch with a visible indicator while it is on, never a silent fallback when the local engine is sick — a fallback that quietly uploads your voice because whisper crashed is the one behaviour this must not have. Settings toggle, per-engine (STT and TTS are separable), with the local path staying whole. | C + UI |
| C12 | ~~**The mic button should react to your voice, not just to being on.**~~ — **done** (the "right" version): the recorder reports a dB-curve level from the capture tail every 100 ms, the live state carries it while the mic is open, and the Mac button's halo is sized by it; the fixed pulse now means only "armed". Phone and TUI have the number and draw nothing yet. It animates with `.variableColor.iterative` while listening — a fixed pulse that looks identical whether conch is hearing you or hearing nothing. That is the wrong thing to be reassuring about: the state people actually want confirmed is "it can hear me", which is exactly what was silently false while the app had no microphone permission. Two levels, and the cheap one is not the right one. **Cheap:** drive it from the live partial transcript the composer already receives — honest, but chunky, since partials land periodically rather than continuously. **Right:** publish an audio level from the recorder into `live` and drive a real meter, which also gives the phone and the TUI something truthful to draw. Tyler: "the animation on the button should probably react to like when I'm saying stuff". | V + UI |
| C13 | ~~**A nested agent's prose renders as raw monospace.**~~ — **done** (#116): a nested agent's reply in a tool result renders as markdown; other tool output stays monospace.  Side by side with Codex's own terminal the gap is stark: Codex draws a real table, nested bullets, coloured inline code and links; conch shows the same reply as a wall of monospace with `**bold**` and `[text](url)` literal. Localised: it is the expanded TOOL RESULT path (`ConversationStackView.swift:412`), which is deliberately `Text(result)` with no markdown parse — correct for shell output, wrong for prose. Codex sessions driven through the desktop app deliver the model's reply inside `function_call_output` (`conversation.ts:883`), so an agent talking through a tool is classified as tool output and gets the log treatment. Do NOT fix this by sniffing whether the content looks like prose; that is how a log file gets mangled. The honest cut is `toolKind` — render markdown for conversational tools, raw for shell and file ones — since conch already classifies them. | UI |
| C14 | ~~**A dropped image becomes its path as text.**~~ — **done** (#119): the editor no longer accepts file drops, so a drop lands on the composer as an attachment; Cmd+V of an image or image file attaches too.  Not a paste problem, and not a missing preview — the composer already renders thumbnails for real attachments and its `.onDrop` already attaches file URLs correctly. The field is a SwiftUI `TextEditor`, which is NSTextView-backed, and AppKit text views accept file drops natively by inserting the path as TEXT. The `.onDrop` sits on an ancestor, so it only wins for drops landing on the surrounding chrome; a drop on the text area itself is taken by AppKit first. Tyler dragged two screenshots in and got two paths in the message body. Fix is at the text view: stop it accepting file drops (unregister the dragged types via an NSViewRepresentable) so the composer's handler receives them. Do paste in the same change: Tyler asked for Cmd+V of an image into the prompt bar, and a screenshot on the clipboard is the same intent as a drop. Both land in the one NSViewRepresentable that owns the text view, so it is one wrapper, two entry points. | UI |

## D. Performance — Phase 4

| | fix | lands in |
|---|---|---|
| D1 | ~~**Kokoro by mode** — manual unloads it; auto warms it. ~650MB.~~ — **done** (2026-09-11). Manual mode unloads the owned Kokoro after a 60 s grace (a quick `p`/`p` never thrashes the model) and a daemon booting in manual mode never loads it; auto mode warms it again. While it is unloaded, explicit speech goes through `say` exactly as while it is loading, and nothing but auto mode reloads it. No setting: an idle window would put the first announcement after a quiet stretch on `say` with no signal to warm under, the trade whisper's mic signal avoids. `conch doctor` says warm / unloaded (manual) / not loaded. | C |
| D2 | ~~**whisper pre-warmed on a signal**, idle-unloaded. ~628MB.~~ — **done** (2026-09-10). An owned whisper-server that has served no transcription for `whisper-idle-unload` minutes (default 20; 0 = never; live) is stopped by the supervisor and reloaded the moment the daemon knows a mic will open — a wake accepted, or a finished turn past every gate, before the bell and the announcement — so the first utterance after a long quiet is warm unless the reload is not done in time, when the cold cli covers it as before. An adopted server is never unloaded; `conch doctor` says warm / unloaded / adopted. | C |
| D3 | ~~**An orphaned whisper-server is adopted forever.**~~ — **fixed** (2026-09-10). Two halves of A2's gap: a ready adopted server was never re-probed (`markReady` cleared the timer, and someone else's process has no exit promise), and the supervisor only ever kills what this daemon spawned, so the server a hard-killed daemon left behind was adopted by every daemon after it — never stopped, never replaced when it wedged, never reloaded after a model change. Now an adopted server is polled every 30 s and the daemon starts its own when it stops answering; each spawn records its pid in `~/.cache/conch/whisper-server.json`, and the next daemon kills that pid before adopting anything — only if its daemon is dead and the pid is still a whisper-server on the port. A stranger on the port is still adopted and never killed; one that stays up but wedged still means the cold cli, and Kokoro has the same gap untouched. | C |

## E. Polish

| | | lands in |
|---|---|---|
| E1 | ~~Reclaim the top of the Mac window — 42pt of header above the content.~~ — **done**: the window already hid its title bar, but SwiftUI kept content below the 32pt strip the traffic lights sit in, so the 38pt header row (plus its divider) stacked under an empty strip; the dashboard's stack now extends under the strip and the header row IS the strip — wordmark, status and the mode/Settings/logs/? controls beside the traffic lights, 78pt in to clear them, 28pt of its own in full screen — and the ledger starts 39pt higher. Nothing moved into a system toolbar; every control kept its label, help text and 26pt hit target. | UI |
| E2 | A design pass on the Mac app, once it is fluid. | UI |
| E3 | Better phone transcription; the bench is written and waiting on one recording. | V |
| E4 | Better phone reading, configurable. | V |
| E5 | Behaviour rules for both apps, written down and made true. | UI |
| E6 | Thread management — archive, pin, snooze. Dismiss and restore cover most of it. | R |
| E7 | Live Activities on the phone. | UI |
| E8 | ~~One universal adapter shape, so a third backend is a table entry.~~ — **done** (2026-09-11): `src/agent-adapter.ts` holds one `AgentAdapter` row per agent (`claudeAdapter`, `codexAdapter`, looked up by `adapterFor(backend)`); the backend branches in the generic modules went from 26 sites to 3 (daemon.ts 9→0, session-lifecycle.ts 6→0, provider-rename.ts 1→0, resumable.ts 2→0, sessions.ts 3→1, agent-capabilities.ts 5→2 — the three left are the two wire validators and `toInfo`, which R owns). A third backend is one union member and one row; `test/agent-adapter.test.ts` registers a fake one and drives label, resume, transcript, picker and capability reads through it. | R |

---

## Where I would draw the line

**Refactor now, before B3, B4, C1, C2 and C3.** Five of the six biggest
remaining features add control messages or queue behaviour, and all five would
land in the same 5,615-line file — the one where two writers already collided
during the parity pass.

*Status 2026-09-11, after a night of agent-built PRs (#120–#158):* **Q** and
**C** are extracted; E8 put the two agents behind one adapter table (26
backend branches → 3, the rest are R's registry seam); C9b shipped its
device identity (A0), the LAN two-Mac slice (A1) and the audio holder with
Take it (Cut B), leaving the relay path (A2) and cross-Mac dictation (Cut C).
`daemon.ts` is 5,213 lines — it grew back with the holder wiring, which is
the argument for **V** (`voice-loop.ts`) as the next cut, and **R**
(`session-registry.ts`) follows from C9b's completeness contract. 28 rows
are struck, 17 open; of those, B3/B5/B6/C1/C2/C3/C5/C6/C11 need a product
decision before code, A5/A6/A13 need a reproduction, and A15's two defaults
(`phone` on, a default relay URL) are Tyler's one-liners.

Specifically:

- **C** (`control-server.ts`) is touched by B3, B4, B6, C1, C2, C3, D3, A2, A3,
  A5. Ten items. It is the seam that pays for itself immediately.
- **Q** (`event-queue.ts`) is touched by C2, which is the one feature that could
  genuinely destabilise the serial invariant — an agent waking another agent is
  a new event source with a loop risk. Splitting first makes that reviewable.
- **V** and **R** are touched by fewer things and could wait.

**Finish first, because they are nearly done and would otherwise rot:**
~~B1~~, ~~A1~~, ~~A4~~ — all three done, along with A7, which was not on this
list until Tyler ran two windows on one session id and found it. The line is
now clear: the refactor is next.

**Explicitly after the refactor:** everything in C, plus B3 and B4.

**Never blocking:** E, and A5–A10, which are real but none of them stop the
next build.
