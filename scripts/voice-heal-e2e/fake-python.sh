#!/bin/bash
# A stand-in CPython @VERSION@, for scripts/voice-heal-e2e.ts only (fake-uv.ts writes it into conch's own Python folder).
# A venv's bin/python links here and $0 is that link, so the venv is two folders up. The probe gets its answer from
# probe.py; the worker is conch's real tts-worker.py, run by the system Python on the stubs in the venv.
venv="$(cd "$(dirname "$0")/.." && pwd)"
site="$venv/lib/python@MINOR@/site-packages"
# What a macOS update that broke a library looks like to anything that runs this Python.
if [ -e "$venv/.dylib-broken" ]; then
  echo "dyld[$$]: Library not loaded: @rpath/libpython@MINOR@.dylib" >&2
  echo "  Referenced from: $0" >&2
  echo "  Reason: tried: '$venv/lib/libpython@MINOR@.dylib' (no such file)" >&2
  exit 134
fi
if [ "$1" = "-B" ] && [ "$2" = "-I" ] && [ "$3" = "-c" ]; then
  exec "@SYSTEM_PYTHON@" -B "@HERE@/probe.py" "$site" "@VERSION@"
fi
if [ "$1" = "-u" ]; then
  shift
  PYTHONPATH="$site" exec "@SYSTEM_PYTHON@" -B -u "$@"
fi
echo "python stand-in: unexpected $*" >&2
exit 2
