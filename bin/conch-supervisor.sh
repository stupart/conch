#!/bin/zsh
# conch supervisor — keeps the daemon's tmux session alive (installed by `conch service`)
while true; do
  "/opt/homebrew/bin/tmux" has-session -t conch 2>/dev/null || \
    "/opt/homebrew/bin/tmux" new-session -d -s conch 'cd "/Users/tylerstupart/conch" && CONCH_KEYSTROKE_FALLBACK=1 CONCH_BARGE_THRESHOLD_PCT=0 "/Users/tylerstupart/.bun/bin/bun" run src/cli.ts daemon'
  sleep 15
done
