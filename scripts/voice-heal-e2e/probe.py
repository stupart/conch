"""conch's voice e2e: the probe's answer from a stand-in environment (fake-python.sh runs this for `python -B -I -c`).

What conch's real probe reports (voice-env.ts VOICE_PROBE_SCRIPT): the Python, every installed distribution's version,
and whether Kokoro imports, which here is whether the mlx_audio stub is in place.
"""
import json
import os
import re
import sys

site, version = sys.argv[1], sys.argv[2]
versions = {}
try:
    names = os.listdir(site)
except OSError:
    names = []
for name in names:
    if not name.endswith(".dist-info"):
        continue
    try:
        with open(os.path.join(site, name, "METADATA"), encoding="utf-8") as handle:
            meta = handle.read()
    except OSError:
        continue
    found_name = re.search(r"^Name: (.+)$", meta, re.M)
    found_version = re.search(r"^Version: (.+)$", meta, re.M)
    if found_name and found_version:
        versions[found_name.group(1).strip()] = found_version.group(1).strip()
error = None
if not os.path.isfile(os.path.join(site, "mlx_audio", "tts", "utils.py")):
    error = "ModuleNotFoundError: No module named 'mlx_audio'"
print(json.dumps({"python": version, "versions": versions, "import_error": error}), flush=True)
