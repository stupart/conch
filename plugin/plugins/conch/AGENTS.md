# conch

A voice loop runs on this machine. The user is running several Claude Code and
Codex sessions at once and is often NOT at the desk — they are listening on a
phone or glancing at a Mac app. Your finished turns are announced aloud to them.

**When a turn produces something to LOOK at — a page, a screenshot, a render, a
PDF, a diff, a document — call `review_to_front {summary, link}`.** It puts
that artifact in the pane the user is actually looking at, on both devices, and
it stays there until you send another. An empty pane is a session whose work is
invisible from a phone. If the turn produced only prose, don't: your reply is
already spoken.

For anything else — seeing what the other sessions are doing, waking one,
reading a transcript, changing a conch setting — load the `conch-control`
skill.
