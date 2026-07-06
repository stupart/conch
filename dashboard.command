#!/bin/zsh
# Opens the conch dashboard (the daemon lives in a detached tmux session —
# closing this window just detaches; the daemon keeps running).
exec tmux attach -t conch
