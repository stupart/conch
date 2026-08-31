# conch roadmap

**This is the master.** Everything open lives here. If it is not in this file
it is not tracked, and that is the point — there were seventeen documents and
Tyler could not tell whether an idea had survived being written down.

The rest of `docs/` is now reference, not planning:

- `architecture.md` — how the system actually works, and what is wrong with it
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

`daemon.ts` is 5,615 lines. `docs/architecture.md` names where it splits:

- **Q** `event-queue.ts` — the queue, drain, enqueue, the serial invariant
- **V** `voice-loop.ts` — wake → speak → listen → deliver
- **C** `control-server.ts` — the socket, dispatch, the one validation boundary
- **R** `session-registry.ts` — reconciling Claude's registry with Codex's DBs
- **UI** — the two apps and the TUI; no daemon change at all

---

## A. Bugs — things that are wrong now

| | fix | lands in |
|---|---|---|
| A1 | ~~**The artifact is hard to find, and the two apps disagree about it.**~~ — **done** (2026-08-20, `6baf30b` + `39c3b86`). Both apps default to the conversation and carry the artifact inline where it happened; on Mac, opening it switches the top tab, and on the phone — which has no tabs — it goes big as a sheet. Design as Tyler settled it, below. | UI |
| A2 | **The Mac app does not respawn a dead daemon**, and hides the start toggle when it happens. `daemon-identity.ts` is written and tested; wiring is the other half. | C |
| A3 | **Two ways to run the daemon** — launchd/tmux and the app. Two owners is the root of A2. | C |
| A4 | ~~Multi-select by voice returns one option~~ — **fixed**. It was already returning sets after the parity pass, so this entry was stale; what was missing was "all of them", which is how people actually answer one out loud. | V |
| A7 | ~~**A session id is not a window, and conch assumes it is.**~~ — **fixed**. `claude --resume <id>` in a second terminal keeps the id, so Tyler works in two windows (`~/arch-website`, `~/arch-swap`) sharing `4eb30ede`. A shared id is now keyed per window (`<id>#<pid>`, `window-key.ts`), which makes every map the daemon keys by id per-window with no other change; hooks are attributed by walking the process tree to the window that ran them, since Claude Code's payload names only the session; ids from outside are translated at the socket door; transcript and label lookups strip back to the session. Both rows now show, each with its own name, status and route. | C |
| A8 | **The conversation pane cannot tell the two windows apart.** Both read one transcript, so a window shows whatever branch was written last — visible as `arch site` displaying arch-swap's work. Claude Code chains messages by `parentUuid`, so the branches themselves separate exactly; what is missing is which branch belongs to which window. Two exact signals exist and are worth trying before any heuristic: the registry entry carries a `bridgeSessionId` whose suffix matches `bridge-session` records in the transcript (both windows write them — 7 and 240 in Tyler's file), and each window's chain has its own leaf. Do NOT map by cwd or recency; a confidently wrong conversation is worse than a shared one. | C |
| A5 | **The relay drops every 100 minutes, exactly.** Five 1006s, evenly spaced. Unexplained; separate from the idle bug fixed on 08-18. | C |
| A6 | **Mac audio degraded** — `say` timed out at 18s, Kokoro hard-restarts. Tracks machine memory; recheck now the Mac is healthy. | V |
| A7 | **Duplicate terminal mouse-up?** Repeated `copied N chars` with nobody selecting. Not investigated. | UI |
| A8 | **A Mac draft can be lost on an unacknowledged send.** | UI |
| A9 | **An image-only send does nothing on the phone.** | UI |
| A10 | **The terminal never consumes the artifact link it is sent.** | UI |
| A11 | **A closed session can keep its pass through manual mode.** `resumedSessionIds` is deleted inside the render prune, but it is not one of the eight collections `trackedIds` is built from, so an id living only there is never iterated and never pruned. It matters more than its size: membership is checked BEFORE the global pause gate (`instant-controls.ts:188`), so that a session resumed by name speaks while everything else stays held — a stale entry is a closed session that can speak through manual mode. Usually pruned via `sessionStates`/`latestTurnBySession`; the gap is when it is not. Fix: add it to `trackedIds`. Found by Codex during the ledger recon; `SessionLedger` pins today's behaviour in a test, so the fix shows up as a deliberate flip. | C |
| A12 | **`reportedMissingCodexPid` never forgets a closed session.** Only cleared for a session still being rendered WITH a pid (`daemon.ts:1287`), so a Codex session that closes pid-less stays for the daemon's lifetime; `closeLiveSession` can also add on a failed close. Unbounded but tiny, and the only behavioural risk is a suppressed warning on id reuse. Fix: delete it in `SessionLedger.forget`. | C |

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
| B2 | **Change the model mid-session.** Both agents expose `/model`; Codex records per-thread model + effort, which the inspector already shows. Same shape as rename: a local slash command into a routable session. | V + UI |
| B3 | **The write pass** — toggle plugins, skills, MCP servers, and per-tool permissions. Needs diff preview, scope, atomic write, readback, rollback, and the "next session" label. | C |
| B4 | **The slash-command palette** — conch's own commands, provider commands, skills, MCP prompts, session actions, in one place. | C + UI |
| B5 | **Approvals** (the four-way decision) and **checkpoint/revert**. Both blocked on ten seconds with permissions on. | V |
| B6 | **Errors that find us** — step 3 of the error work: an agent watches the structured log and investigates unprompted. | C |
| B7 | **Phone: an image-only send, and a working folder for fresh sessions.** | UI |

## C. Beyond parity — what conch can do that neither agent can

| | add | lands in |
|---|---|---|
| C1 | **Configuration at session START.** The only moment a toggle is honest. Turns B3's hard problem into a non-problem. | C |
| C2 | **Agents messaging each other through conch.** conch owns delivery, addressing and every transcript; agents cannot reach any of it. Needs a real answer on loops and consent first. | Q + C |
| C3 | **Discovery and the unified marketplace** — skills, plugins, marketplaces, MCP servers, and possibly workflows/loops/prompt templates. The last three are the scope trap. | C + UI |
| C4 | **Subagents nested under their session**, folder-style, plus a way to reach one from the conversation. Constraint: a subagent stopping is not the parent's turn ending. | R + UI |
| C5 | **Make the plugin genuinely useful**, and review it in detail. It is the one surface agents read, so it decides whether any of the above gets used. Includes the `review_to_front` rename and documenting the contract. | plugin |
| C6 | **Phase 3, the feed.** Deliberately last, and a VIEW over what exists. | UI |
| C7 | **A conch session that ships with conch** — always there, knows the app, and can troubleshoot it for the person using it. Most of it exists: the plugin already carries the control skill and nine `conch_*` tools, so an agent can already see sessions, wake one, speak, rename, switch mode and read config. Two things are missing. It has to EXIST by default rather than be a session you remember to start — and it cannot currently see conch's own health, which is the whole job. Diagnosing the 08-30 dead mic button meant reading `/tmp/conch-daemon.log` for an absent wake line and `/tmp/conch-sessions.json` for `state: "paused"`; neither is reachable through a tool, so the session could not have found it. The diagnostic surface is the work, not the session. | plugin + C |
| C8 | **Teleport, and conch's local-only resume.** Claude Code already answers "continue this session on another machine" and conch does not know about it. `/teleport` uploads the session to the cloud INCLUDING a git bundle (`teleport_git_bundle_upload`), and `claude --teleport [session]` pulls it into a terminal on the new machine, switching git branches on arrival and auto-stashing anything local first; it needs a Claude.ai account. What arrives is a FORK, in Claude Code's own words: "This terminal now has its own copy of the session: new work here stays local and will not appear in the Claude app." That is distinct from `/remote-control`, which leaves the session running here and makes other devices a remote control. **Codex has no teleport** — it has `codex remote-control {start,stop,pair}` (the same short-lived pairing-code shape conch already uses) and `codex cloud {exec,status,list,apply,diff}`, which runs a task remotely and applies the diff locally; neither moves a live local session. So the gap is conch's own: the resume list reads local files only (`resumable.ts:130`) and resuming shells out to `cd <cwd> && exec claude --resume <id>` on THIS Mac (`session-lifecycle.ts:56`). Work: surface teleported/cloud sessions in the resume picker and offer `--teleport` beside `--resume`, with the fork semantics said out loud — someone picking from a list must not think they are joining a session when they are branching it. Codex rows stay remote-control-shaped until Codex ships an equivalent. Verified against the installed binaries 2026-08-30, not from memory. | C |
| C9 | **More than one conch.** A second laptop works, and the two are simply blind to each other: separate daemon, socket, registry (each reads its own machine's `~/.claude/sessions`) and TTS. The "two daemons fight over one socket and one mic" hazard is within a machine, not across. The collision is the phone: pairing is per-machine (`~/.config/conch/relay-pairing.json`, its own room id and secret) and the iOS app stores exactly ONE — `PairingStore.save` calls `delete()` first and writes a single fixed Keychain account (`BridgeClient.swift:742`). So pairing a new laptop UNPAIRS the old one, silently, which is the first thing anyone with two machines will hit and should at minimum say so. Cheapest first: (1) the phone holds N pairings and switches — a list where there is now a scalar; (2) both machines' sessions in one ledger, since the relay already carries what that needs; (3) one conch primary and the other relaying into it, only if (2) shows it is wanted. Start at (1); do not build (3) on speculation. | C + UI |

## D. Performance — Phase 4

| | fix | lands in |
|---|---|---|
| D1 | **Kokoro by mode** — manual unloads it; auto warms it. ~650MB. | V |
| D2 | **whisper pre-warmed on a signal**, idle-unloaded. ~628MB. | V |
| D3 | **An orphaned whisper-server is adopted forever.** Same ownership gap as A2/A3. | C |

## E. Polish

| | | lands in |
|---|---|---|
| E1 | Reclaim the top of the Mac window — 42pt of header above the content. | UI |
| E2 | A design pass on the Mac app, once it is fluid. | UI |
| E3 | Better phone transcription; the bench is written and waiting on one recording. | V |
| E4 | Better phone reading, configurable. | V |
| E5 | Behaviour rules for both apps, written down and made true. | UI |
| E6 | Thread management — archive, pin, snooze. Dismiss and restore cover most of it. | R |
| E7 | Live Activities on the phone. | UI |
| E8 | One universal adapter shape, so a third backend is a table entry. | R |

---

## Where I would draw the line

**Refactor now, before B3, B4, C1, C2 and C3.** Five of the six biggest
remaining features add control messages or queue behaviour, and all five would
land in the same 5,615-line file — the one where two writers already collided
during the parity pass.

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
