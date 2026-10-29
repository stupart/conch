# Annotate a deliverable

Tyler, 2026-10-28: "let's add annotate on the deliverables plane like u can do in codex — make sure the feature makes
sense and test the user journey for design and engineering end to end."

## What Codex does

Codex's in-app browser has an **Annotate** toggle (shipped 26.415, April 2026; batching in 26.519, Markdown and code in
26.707, generated images in 26.727). With it on, page clicks are blocked: you click an element or drag an area, write a
comment and save it, and it becomes a numbered marker on the page and an attachment in the composer. You can save
several (⌘↩ saves and keeps going; ↩ sends that one), then send a chat message asking Codex to address them. A saved note
keeps the element it captured and doesn't re-run hit testing. OpenAI doesn't publish the payload. Third parties report a
screenshot plus the element's tag, attributes and DOM path, and one bug report suggests the screenshots are embedded in
the message. Sources: learn.chatgpt.com/docs/browser.md, …/annotations-extensibility.md, …/changelog, and GitHub issues
22719 and 38996 on openai/codex.

The job underneath: point at exact things in what the agent built, say what to change about each, and give the agent one
batch it can act on without guessing what "here" meant.

## What annotate is in conch

conch already has two pieces this has to fit with:

- **The canvas** is freehand ink on a glass over the whole screen, anchored to the display. Send screenshots what is under
  the ink (that needs Screen Recording) and describes each note as a percentage of the screen ("box (62%,18%)"). It works
  over anything, but the agent has to work out from a picture which element "62%,18%" was.
- **Agent ink** is the marks an agent publishes on its deliverable (`scene.marks`). They are anchored to what the
  deliverable *is*: `{selector}` or `{quote}` in a page, `{image}` plus a rect on a picture, or `{canvas}`.

Annotate is the third side of the triangle: **Tyler's notes on a deliverable, anchored the way agent ink is.** It only
works in the deliverables pane, where conch draws the deliverable itself, so it can name what Tyler pointed at in the
agent's own terms. A note on a button arrives as `{selector: "section.hero > a.cta"}`, and the agent can answer by
publishing its next version with a mark on that same selector, which conch draws in the same place. The two directions use
one set of anchors.

| | Canvas | Annotate |
|---|---|---|
| Where | Anything on screen | A deliverable in conch's pane |
| Anchored to | The display | An element, words, or part of a picture |
| Follows scroll and zoom | No; it's a moment in time | Yes |
| Picture | Screen capture; needs Screen Recording | conch's own renderer; no permission |
| Goes to | Whoever owns the screen (asks when unsure) | The session that published it, always |

## The journey

1. Open a deliverable in the pane: a page, a picture, a Markdown or text file, or a file picked in a folder deliverable.
2. Press **Annotate**. For a page it's on the address line; for anything else it's a corner button. The pane gets an
   orange edge and a hint, and on a page, clicks stop following links.
3. Point at something:
   - **On a page**, hover outlines the element under the pointer and names it (`a.cta`). Click it, or select some words.
   - **On a picture**, drag a box or click a spot.
   - **In a document**, select some words.
4. A numbered pin lands on the thing you pointed at, with a note field beside it. The field opens to the right of the
   pin; if there's no room there, it goes below the element, then above it, so it never covers what the note is about.
   Type what to change. ↩ saves the note and lets you keep going. Esc throws away a new note that has no words. Click any
   pin to edit it or delete it.
5. The tray at the bottom of the pane counts the notes, lists them, and has **Send to *session*** (⌘↩). Esc or the button
   ends annotating; the notes stay until they are sent or cleared.
6. Send delivers one message to the session that published the deliverable, through the same path the composer uses. It
   appears in the conversation as Tyler's message. The pins clear and the tray says "Sent to *session*". If delivery fails,
   the notes come back and the tray says why.

## What is anchored, and what is pictured

| Shown as | You point by | Anchor (agent ink's frames) | Picture |
|---|---|---|---|
| Page (URL or local html) | Click | `{selector}`, plus its tag, opening words and key attributes | The element plus a margin, outlined |
| Page | Selecting words | `{quote}`: one line, found the way agent ink finds a quote | The words plus a margin, outlined |
| Image | Drag, or click | `{image: path}` with `rect` or `at` in fractions, top left | That region of the original pixels, outlined |
| Markdown or text | Selecting words | `{quote}`, in its file | None (the words are the content) |
| Folder | Whichever file is picked | As above, for that file, with its path | As above |
| PDF, video, anything unpreviewable | — | Annotate isn't offered; the canvas covers these | — |

A selector is the shortest unique one: an id or test id where there is one, otherwise tag and classes (machine-made
class names are skipped), with `:nth-of-type` only where it's needed. It stays within agent ink's 120-character limit, so
the agent can paste it straight back as a mark's frame. Text you select becomes the quote: its longest line, up to 120
characters, which is also what agent ink's finder searches for. If the selection was longer, the full text goes along as
context.

## What the agent receives

One message. The overview picture comes first, because both agents read an image whose path is in the message:

```
~/.cache/conch/annotations/<id>/overview.png
[annotate] Tyler left 3 notes on your deliverable "Landing page" (http://localhost:5173/).
1. {selector: "section.hero > a.cta"}, the <a> "Start free trial": "make this bigger"
   Picture: ~/.cache/conch/annotations/<id>/1.png
2. {quote: "Ship faster with"} (selected: "Ship faster with fewer meetings"): "too long, five words at most"
   Picture: ~/.cache/conch/annotations/<id>/2.png
3. {selector: "#pricing > div:nth-of-type(2)"}, the <div> "Team $12/mo": "highlight this plan" (not on the page when
   sent: the page changed after it was pinned)
   Picture: ~/.cache/conch/annotations/<id>/3.png
The page with the notes numbered: …/overview.png. Everything above as JSON: …/notes.json
To point back at any of these, publish marks with the same frame (review_to_front scene.marks).
```

A note on an image reads `{image: "/path/shot.png"} rect [0.12, 0.40, 0.30, 0.18]`. Those are the same fractions an
agent's mark takes. A note on a document reads `{quote: "…"} in /path/README.md`. The folder is
`~/.cache/conch/annotations/<id>/`, private (0700) like the canvas's, and cleared after 14 days.

## Choices made to keep the journey simple

- **Send goes straight to the session, not into the composer.** In Codex, notes become composer attachments, because
  Codex has to be told which thread they're for. In conch the deliverable already belongs to a session, so there is nothing
  to route and no reason to make two steps of one. The composer is still where free-form words go.
- **↩ saves, ⌘↩ sends.** Batching is the common case. Codex's "↩ sends this one" is reported as a surprise (openai/codex
  issue 22719).
- **A note needs words.** A pin with nothing to say is closed without being kept, so a stray click never sends.
- **Pins follow the content.** They scroll, zoom and resize with it. After a reload, notes are found again by their
  anchors. A note whose element or words are gone stays in the tray, marked "not on the page now". It is still sent, with
  the picture taken when it was pinned and the line saying so. A selector that names an element by its position
  (`div.card:nth-of-type(2)`) only counts as found while that element still starts with the words it had. Otherwise,
  removing the Team plan would quietly move its note onto Pro.
- **The session has ended.** The daemon drops the row, and the deliverable goes with it. Notes left on it aren't lost:
  whatever the pane shows next says "*session* ended with 2 notes you hadn't sent", with Copy notes and Discard. A session
  that's listed but can't take a message (the composer's own "unavailable" reason) turns Send off, and the tray gives the
  reason.
- **Taken isn't landed.** If the daemon takes the send and the session refuses it later, the notes go back to the
  deliverable they came from, not to whatever the pane shows by then, and the tray says why.
- **Notes live per deliverable, for as long as conch runs.** Moving to another tab and back keeps them; quitting conch
  doesn't.

## How it's tested

- `design/ConchDesign`'s `AnnotateTests` cover the batch, the message for each anchor kind, the JSON, the geometry, and
  the pictures. `AnnotateScriptTests` run the page script in real WebKit, in its own content world. They check that a
  click names the element with a unique selector and doesn't follow the link; that selected words become a one-line quote
  which agent ink's finder finds at the same place; and that notes are found as the page scrolls, lost when it changes,
  found again after a reload, and never moved onto another element. `AnnotateRenderTests` draw the tray and the field,
  light and dark.
- `scripts/annotate-e2e.ts` runs this checkout's daemon and this checkout's app against each other and nothing else. It
  uses a temporary home, its own socket and its own tmux server, with `$TMUX` unset. The app is built under its own bundle
  id, so it never shares conch's preferences. Three stand-in sessions publish a live page, a picture and a folder. The
  harness walks the whole journey in the real pane, light and dark, photographs each step, and checks what reached each
  session. Each message arrives whole, each frame is right, each picture is on disk, the session's own transcript
  confirms each send, and nothing touches the clipboard. The script ends with a session closing while notes wait.

## Out of scope, and follow-ups

- On the phone: the deliverable sheet already draws agent ink, so the anchors would carry over, but notes, crops and their
  upload are a separate piece of work.
- PDFs, video and app windows: the canvas covers them.
- Hold-to-interact while annotating (Codex holds Space). For now, turn annotate off to click the page.
- Live style tweaks (Codex's Adjust).
- Notes kept across a relaunch.
- Annotating in the Workdesk's browser tabs. The same bridge would fit there, but the owning session is less certain.
- On a document, the pane's corner buttons can sit over its first line in a narrow column; Annotate adds a second one.
  This predates annotate (↗ does it too). A thin header line like a page's address line would fix both.
- A quote's wash is one rectangle around all its lines. The page could hand over a rectangle per line instead.
