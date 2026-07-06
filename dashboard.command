#!/bin/zsh
# The conch dashboard. The daemon lives in a detached tmux session; this
# attaches to it and — if the daemon RESTARTS (launchd respawns it) — waits
# and reattaches, so this window survives restarts instead of dying.
# Detaching on purpose (ctrl-b d) leaves the session alive, so we exit
# cleanly. Closing the window only detaches; the daemon keeps running.
echo "🐚 conch dashboard"
while true; do
  tmux attach -t conch 2>/dev/null
  if tmux has-session -t conch 2>/dev/null; then
    break # session still alive => you detached on purpose
  fi
  echo "daemon restarting… reattaching"
  while ! tmux has-session -t conch 2>/dev/null; do sleep 1; done
done
