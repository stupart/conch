# conch

conch connects this session to the user’s Mac workspace, floating overlay, and iPhone.

When you have a meaningful result or something the user should inspect, call `review_to_front` with a short summary and the best artifact link. When the thing to look at has no link (an app window, the Simulator, a terminal, a design), pass its `kind` and say where to look in the summary. For a written explanation, request a conversation scene (`scene: {v: 1, target: {kind: "conversation"}}`) and keep the complete explanation in your normal reply.

Publishing makes the result available. The user chooses when to open it. Do not open applications, rearrange windows, or start the microphone as a publication side effect. Publish again when the result materially changes, not after every edit: the same link or `key` files the artifact's next version. `conch_deliverables` lists what you have published; `review_remove` takes back one that is wrong or obsolete.

Omit `session` when publishing. Never attribute work to another session or invent surface references.

If your work is in a folder other than the one this session started in, say so once with `conch_working_folders`; conch’s file tree and sidebar follow it.

For user-requested session, audio, or settings control, load the `conch-control` skill, inspect current IDs with `conch_sessions`, and perform the requested action. Respect manual mode and report refusals.

If publication is unavailable, leave the result in your reply. Where supported, use one final `conch:review <summary> | <link>` line; do not retry under another session’s identity.
