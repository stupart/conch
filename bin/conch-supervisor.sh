#!/bin/zsh
# conch supervisor — keeps the daemon alive (installed by `conch service`)
#
# Liveness is the DAEMON PROCESS, not the tmux session. A session outlives a
# dead pane, so `has-session` reported healthy while conch was gone — a silent
# outage that survives indefinitely because the check can never fail. Killing
# the stale session first is what lets new-session run at all.
while true; do
  # Match how the daemon ACTUALLY runs, not one spelling of it. This read
  # `bun run src/cli.ts daemon`, but `conch service install` starts it as
  # `bun /abs/path/src/cli.ts daemon` — no `run` — so the pattern never
  # matched, the supervisor believed conch was dead, and it killed and
  # recreated the session every 5 seconds. Observed live: the socket owner
  # changed four times in twelve seconds.
  #
  # `cli.ts daemon` covers every spelling; filtering to a bun process is what
  # keeps a tmux wrapper carrying the same words in its argv from counting as
  # the daemon it is merely launching.
  if ! pgrep -f 'cli.ts daemon' 2>/dev/null | xargs -I{} ps -o comm= -p {} 2>/dev/null | grep -q bun; then
    # Clear a stale session and create on the NEXT pass. Killing the last
    # session stops the tmux server, and a new-session issued in the same
    # breath races that shutdown — measured healing at 30-45s instead of one
    # interval, sometimes not at all. has-session is sound for "is there
    # something to clear"; it was only ever wrong as a liveness test.
    if "/opt/homebrew/bin/tmux" has-session -t conch 2>/dev/null; then
      "/opt/homebrew/bin/tmux" kill-session -t conch 2>/dev/null
    else
      "/opt/homebrew/bin/tmux" new-session -d -s conch 'cd "/Users/tylerstupart/conch" && CONCH_KEYSTROKE_FALLBACK=1 "/Users/tylerstupart/.bun/bin/bun" run src/cli.ts daemon'
    fi
  fi
  sleep 5
done
