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
