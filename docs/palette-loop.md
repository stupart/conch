# The loop I am running to build the capability palette

Written down so it can be inspected and interrupted. Tyler: "design an agentic
loop for yourself and use it to execute on a goal with codex's help. dont wait
for me."

## The goal

A capability palette in the Mac app — plugins, skills, MCP servers and their
tools — built against the readers in `src/agent-capabilities.ts`, following
`docs/palette-plan.md`. Then the same on the phone.

Done means: Tyler can look at a session and see what it is actually carrying,
with every claim labelled by how conch knows it.

## The iteration

1. **Pick one increment.** Smallest thing that changes what is on screen.
2. **Build it.**
3. **Gate:** `bunx tsc --noEmit` clean, `bun test` green, the app builds.
4. **SEE IT.** Install, launch, `conch shot`. Never judge UI from source — this
   loop exists because I have twice called something done from a green build.
5. **Judge against the criteria below.** Write the verdict down before fixing,
   so I am not grading my own work after the fact.
6. **Every third iteration, hand it to Codex** for adversarial critique of the
   real diff, and act on what survives.
7. Repeat until the criteria pass, then move to the phone.

## The criteria

An increment is finished when all of these hold:

- **It reads as an inspector, not a settings screen.** No control appears that
  conch cannot honestly perform. This pass has no writes at all.
- **Every claim carries its basis.** A row saying "configured" must be able to
  say where that came from. Unknown is a first-class state and must look
  deliberate, not broken.
- **The two agents stay distinct.** A Codex server and a Claude server are
  never merged into one row or one switch; they are different mechanisms.
- **It uses conch's existing tokens.** No new visual language, no new palette
  entries, and selection must outrank hover as it does everywhere else.
- **Density without clutter.** 107 Codex and 205 Claude entities is a lot; the
  default view must be scannable, with detail on demand.
- **It is a rankable item, not a screen.** Each entity keeps a stable subject
  identity so the feed can later surface "this MCP server needs auth" without
  a rewrite. Per `docs/vision.md`.

## Stop conditions

Stop and ask rather than guess when:

- an action would WRITE to a user's Claude or Codex configuration;
- the honest answer is "conch cannot know this" and the UI would have to imply
  otherwise;
- a design choice is a real product decision rather than a mechanical one.

## Log

Each iteration appends: what changed, what the screenshot showed, the verdict.

### Iteration 1 — the inspector exists

Built the Swift model, the view, the store method and an entry point in the
session overflow menu. Screenshot: the sheet rendered but said "Could not read
this session's capabilities". Two real bugs behind it, both found only by
looking: the Mac's `SessionRow` never decoded `cwd` (the daemon has it and does
not publish it), and the control-message validator rejected an empty one.
Resolved by letting the DAEMON resolve a session's directory — a client that
can already name a session should not have to know its filesystem path, and the
alternative was publishing a path on every row for one deliberate lookup.

Verdict: works against real config. 8 MCP servers, 11 plugins, descriptions and
child counts, read in tens of milliseconds.

### Iteration 2 — rows that looked like duplicates

Screenshot showed `context7` twice under MCP servers and twice under plugins,
with nothing separating them. They are genuinely different entities — one from
a user-scope plugin, one from a project marketplace — so the list was correct
and unreadable at the same time.

First attempt labelled every namesake with its own `scope`, which fixed the
plugins (`local` / `user`) and did nothing for the servers, whose scope is
"plugin" in both cases. What actually differs there is the scope of the plugin
that OWNS them. Now a badge appears only when it genuinely separates a row from
its namesake, and never otherwise: two rows conch cannot tell apart should look
like two rows, not like two broken badges.

Verdict: passes. Duplicates disambiguate; unique rows stay clean.

### Iteration 3 — the evidence detail

Expanded a row. Every state carries its reason:

    configured  A redacted MCP server definition exists on disk.
    available   Disk configuration does not prove that a fresh or attached
                host made this available.
    loaded      Conch is attached to a host it did not initialize, so loaded
                state is not observable.
    observed    No use has been observed; absence of evidence is not evidence
                of absence.

Verdict: the "every claim carries its basis" criterion is met. Handing the diff
to Codex for adversarial review before going further.

### Iteration 4 — Codex's critique, and the lie it caught

Handed the diff to Codex per step 6. It found eight defects, seven of them
certain, and the worst was the one the whole feature exists to prevent.

**A disabled thing looked exactly like a working one.** `headline` preferred
`configured: yes` whenever a definition existed on disk, so a switched-off MCP
server, plugin or denied tool rendered with the same calm "configured" chip as
a live one. The reader could prove `available: no` and the row hid it. Fixed by
leading with unavailability, and the screenshot immediately showed two of
Tyler's servers as **disabled** — `playwright`, rejected for this project, and
`posthog`, whose plugin is `false` in `settings.json`. Both verified in his real
config before trusting my own fix, because a false "disabled" is now a loud lie
rather than a quiet one.

**"trust not decided" was unsupported.** nil arises both when no decision was
recorded AND when conch could not read the file that would hold one. Now "trust
unknown", with the reader's own detail in the tooltip.

**"started with" overstated the receipt.** The reader's contract calls it
configuration persisted for a thread, not a launch snapshot; nothing shows the
values have not changed since. Now "Codex recorded".

**"Some sources could not be read" could itself be false** — incompleteness also
comes from a row limit or a missing package. Now "This list is a floor, not a
census", with the inventory-level diagnostics rendered beneath it; they were
decoded and never shown, so a partial read could look like an authoritative
empty one.

**An empty cwd fell back to the home directory**, producing a coherent inventory
of somewhere else wearing this session's name, undetectable from the UI. It
fails loudly now, and the validator rejects an empty cwd with no session to
resolve it from.

**Evidence showed prose without values.** Each line now carries its state —
`configured yes`, `available unknown` — which is most of what "every claim
carries its basis" actually meant.

**The badge was ambiguous and still permitted identical rows.** A bare "user" on
a server whose own scope is "plugin" reads as the server's scope; it says
"from user" now, and falls back to a distinguishing path when neither scope
separates namesakes.

Still open, and honest to state: the Swift model discards kind-specific
metadata — transport, version, marketplace, skill visibility, tool approval
mode — so the plan's per-kind "show" requirements are not met yet. That is the
next increment, not a defect in what is there.

Verdict: the honesty defects are closed. The completeness gap is not.
