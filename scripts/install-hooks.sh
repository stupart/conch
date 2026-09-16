#!/bin/bash
# Point this clone's git hooks at scripts/hooks/, so pre-push runs the gate.
# Repo-local — it writes core.hooksPath into this repo's .git/config, nothing
# global — and the path is relative, so every worktree runs its own copy.
set -eu
git -C "$(dirname "$0")/.." config core.hooksPath scripts/hooks
echo "✓ core.hooksPath = scripts/hooks — pre-push now runs scripts/ci-local.sh"
