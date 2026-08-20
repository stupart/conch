# Discovery, and the thing that isn't built yet

Captured 2026-08-20 from Tyler, while the capability inspector was being built.
The inspector answers "what is this session carrying". These are the questions
it does not answer, and they are bigger than it is.

## In his words

> theres also a discovery problem of seeing new plugins, marketplaces, and
> skills a user can add etc - also thats across each (cc and codex)
>
> Maybe theres like a unified marketplace type thing like Figma has for
> community but with all the skills, plugins, marketplaces, mcps, workflows /
> loops, prompt templates, ect? Then icons and filters of only relevant to one
> of the platforms, can add and manage in there and then also change them
> per-session from inside the session or when starting a new session have the
> settings be there too?
>
> showing sub-agents nested in the main menu under their main sessions like
> folder structure, also ability to access them from in the chat here not sure
> what the best ux is there tho maybe its related to how we do the tools
> (skills, plugins ) or maybe its accessed somewhere else in the chat

## 1. Discovery is a different problem from inventory

Everything built so far reads what a session ALREADY has. Nothing helps you
find what you could add. Both agents have their own answer to this and neither
is shared: Claude Code has marketplaces (`extraKnownMarketplaces` in settings,
a plugin catalog cache on disk), Codex has its own plugin and skill roots. A
person using both has two catalogues, two idioms, and no single place that says
"here is what exists".

The asymmetry matters for what conch is: it already attaches to both agents and
shows them in one ledger. It is the only surface that sees both, so it is the
only place a unified catalogue can honestly live.

## 2. The unified marketplace

The Figma Community comparison is the right one, and it sets the bar: browsable,
visual, filterable, with the thing itself previewable before you take it. Not a
package list.

What it would carry, in his enumeration: **skills, plugins, marketplaces, MCP
servers, workflows/loops, prompt templates**. Note the last three — workflows,
loops and prompt templates are not things either agent currently packages. That
is either the most interesting part of this idea or a scope trap, and it should
be decided deliberately rather than by accident.

Design constraints that follow from what we already know:

- **Per-platform icons and filters.** An item is for Claude Code, for Codex, or
  for both. The inspector already refuses to merge a Claude entity and a Codex
  entity into one row; a catalogue must not either. The filter is not a
  convenience, it is the honesty.
- **Install is a WRITE**, so it inherits everything the write pass owes: diff
  preview, scope, atomic write, readback, rollback, and the truthful label that
  nothing affects a session already running.
- **It is a feed of artifacts.** Per `docs/vision.md`, everything built before
  the feed should produce rankable items with a subject. A marketplace entry is
  exactly that shape, and a catalogue built as a screen would be a rewrite
  later. Build the entries as items.

## 3. Configuration where the work is

> change them per-session from inside the session or when starting a new
> session have the settings be there too

Two placements, and both are right for different moments:

- **In the session**, because that is where you discover you need something.
- **At session start**, because that is the only moment a change can honestly
  take effect — every toggle we can write is "next session", so the start sheet
  is where a toggle is not a lie.

The second is the stronger version of the write pass. `session-lifecycle.ts`
already builds the launch command, and `bypass-permissions` proved the shape:
a setting resolved at start time, applied to the process that is about to
exist. Plugins, skills and MCP servers can work the same way — which sidesteps
the entire "cannot change a running host" problem rather than fighting it.

This is what `docs/palette-plan.md` calls "named launch profiles", ranked
fourth there. Tyler's framing makes it more important than that: it is not a
power-user convenience, it is the only place the controls are honest.

## 4. Subagents, nested

> showing sub-agents nested in the main menu under their main sessions like
> folder structure

conch already knows subagents exist — `subagent` is a tool kind, and the
backlog has carried "subagents as children of their session, transcripts
readable, ideally talkable-to" for weeks. What is new here is the shape: a
folder structure in the ledger, not a separate view.

The open question is his: how do you reach one from inside the conversation?
Three candidates, and this is a real product decision rather than a mechanical
one:

1. **Inline where it happens.** A subagent row in the conversation expands into
   its transcript, the way a tool row expands into its result today. Closest to
   what exists; risks burying a long-running child in scrollback.
2. **Nested in the ledger.** A child row under its parent session, selectable
   like any other. Matches his folder-structure framing, and makes a blocked
   child visible without opening anything.
3. **Both, with the ledger as the index.** The row in the conversation is where
   it happened; the entry in the ledger is where it lives.

Worth noting the constraint conch already learned: a subagent stopping is NOT
the main turn stopping (`SubagentStop` is explicitly dropped in `hook.ts`), so
a nested row must not inherit the parent's status or announce like one.

## Where this sits

None of this is started. It sits after the write pass and before the feed —
and it is plausibly the thing that makes the feed worth having, since a
catalogue of installable things is a natural source of rankable items.
