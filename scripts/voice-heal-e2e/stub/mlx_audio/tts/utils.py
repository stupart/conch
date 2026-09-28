"""conch's voice e2e: a stand-in for mlx-audio's Kokoro loader (scripts/voice-heal-e2e.ts).

It keeps Kokoro in the Hugging Face cache exactly as huggingface_hub lays it out (content-addressed blobs, snapshot
links), fetches only what is missing from HF_ENDPOINT (the test's local server), and fails the way the real one does:
a damaged weight file is a SafetensorError, no network a ConnectionError. Its audio is silence, and it only ever goes
into the WAV file conch asks for: nothing here can make a sound.
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from pathlib import Path

COMMIT = "c0ffee" + "0" * 34
SAMPLE_RATE = 24000


def _hub() -> Path:
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"])
    return Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub"


def _fetch(repo: str, path: str) -> Path:
    base = _hub() / ("models--" + repo.replace("/", "--"))
    link = base / "snapshots" / COMMIT / path
    if link.exists():
        return link
    endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co")
    url = f"{endpoint}/{repo}/resolve/main/{path}"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = response.read()
    except OSError as error:
        raise ConnectionError(f"(MaxRetryError(\"HTTPConnectionPool: Max retries exceeded with url: /{repo}/resolve/main/{path}\")) {error}")
    if path.endswith(".safetensors"):
        etag = hashlib.sha256(data).hexdigest()
    else:
        etag = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
    (base / "blobs").mkdir(parents=True, exist_ok=True)
    (base / "refs").mkdir(parents=True, exist_ok=True)
    (base / "blobs" / etag).write_bytes(data)
    (base / "refs" / "main").write_text(COMMIT)
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        link.unlink()
    link.symlink_to(os.path.relpath(base / "blobs" / etag, link.parent))
    return link


def _check(link: Path) -> None:
    data = link.read_bytes()
    if link.name.endswith(".safetensors"):
        if hashlib.sha256(data).hexdigest() != os.path.basename(os.path.realpath(link)):
            raise Exception("safetensors_rust.SafetensorError: Error while deserializing header: HeaderTooLarge")
    elif link.name.endswith(".json"):
        json.loads(data)


class _Result:
    def __init__(self, audio: list, sample_rate: int) -> None:
        self.audio = audio
        self.sample_rate = sample_rate


class _Model:
    def __init__(self, repo: str) -> None:
        self.repo = repo

    def generate(self, text, voice="af_heart", speed=1.0, lang_code="a", verbose=False):
        _check(_fetch(self.repo, f"voices/{voice}.safetensors"))
        yield _Result([0.0] * max(240, min(24000, len(text) * 400)), SAMPLE_RATE)


def load_model(repo: str) -> _Model:
    for path in ("config.json", "kokoro-v1_0.safetensors"):
        _check(_fetch(repo, path))
    return _Model(repo)
