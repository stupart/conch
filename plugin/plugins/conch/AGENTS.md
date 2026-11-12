# conch

conch shows this session in the user’s Mac app, floating overlay and iPhone. Its Mac app gives you a Workdesk of typed items beside the conversation: deliverables, browser tabs, files, shell, terminal. Show your work there: results with `review_to_front`, pages with `conch agent browser open`.

Whenever you produce something the user would look at (a page, screenshot, file, document, plan, diff or PR, build, app state), publish it with `review_to_front` as you go, not only at the end: a short summary and the best artifact link. Tell the user where it landed from the result’s `surfaces`. With no link (an app window, the Simulator), pass its `kind` and say where to look. For a written explanation, use scene kind `conversation` and keep it in your reply.

A link is an http(s) URL, or a path to a file or a folder (shown as its file tree) under this session’s folders (where it started or is now, its git repository, `conch agent folders`) or a temp folder (/tmp, /var/folders/…/T), which conch copies so cleaning it can’t take it away. Never a hidden file, key or executable.

Everything else is a command in your shell: `conch agent help` lists them; if your shell can’t reach conch (a sandbox), the `conch_run` tool runs the same words. Browse for the user with `conch agent browser …` so they can watch in the Workdesk; other browser tools are fine when they ask or the task needs them. At a sign-in, ask them to sign in in the tab with `conch agent browser ask`; never type passwords. `conch agent capture <url>` shows part of a page. `open <url>` lands in the Workdesk; `CONCH_OPEN_EXTERNAL=1 open <url>` uses the default browser. Show an Atlas page that matters to the user with `conch agent atlas`.

Publishing makes the result available without interrupting the user: open no apps, move no windows, start no microphone. Publish again whenever it changes in a way worth seeing, not after every edit: the same link or `key` files its next version. `conch agent deliverables` lists yours; `conch agent unpublish` takes back a wrong one.

Omit `session` when publishing; never attribute work to another session. Working outside the folder this session started in? Say so once with `conch agent folders <dir>`.

To control sessions, audio or settings when asked, load the `conch-control` skill and check IDs with `conch agent sessions`; respect manual mode and report refusals. When conch itself gets something wrong, `conch bug` files a private ticket for the user.

If you can't publish, end your reply with one `conch:review <summary> | <link>` line (only the last counts, so link a folder for several things). A refused link is dropped and the summary kept; conch tells the user and you why.
