#!/usr/bin/env python3
"""Conch-owned warm Kokoro MLX worker.

stdin/stdout are a private NDJSON protocol.  All library output is redirected
to stderr before mlx_audio is imported so a diagnostic can never corrupt a
protocol frame.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
import wave
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = 1
PROTOCOL_STDOUT = sys.stdout
sys.stdout = sys.stderr

VOICE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
OUTPUT_NAME = re.compile(r"^conch-tts-worker-[A-Za-z0-9_.-]+\.wav$")
MAX_TEXT_CHARS = 20_000


def emit(payload: dict[str, Any]) -> None:
    print(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        file=PROTOCOL_STDOUT,
        flush=True,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Conch warm MLX Kokoro worker")
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", default='["af_heart"]')
    parser.add_argument("--warmup-voice", default="af_heart")
    parser.add_argument("--warmup-speed", type=float, default=1.35)
    return parser.parse_args()


def parse_voices(raw: str, warmup_voice: str) -> list[str]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        value = []
    if not isinstance(value, list):
        value = []
    voices: list[str] = []
    for item in value:
        if (
            isinstance(item, str)
            and VOICE_NAME.fullmatch(item)
            and item not in voices
        ):
            voices.append(item)
    if VOICE_NAME.fullmatch(warmup_voice) and warmup_voice not in voices:
        voices.insert(0, warmup_voice)
    return voices or ["af_heart"]


def validate_request(value: Any) -> tuple[str, str, str, float, Path]:
    if not isinstance(value, dict):
        raise ValueError("request must be a JSON object")

    request_id = value.get("id")
    if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
        raise ValueError("id must be a non-empty string")
    if value.get("op") != "synthesize":
        raise ValueError("unsupported op")

    text = value.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text must be non-empty")
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError(f"text exceeds {MAX_TEXT_CHARS} characters")

    voice = value.get("voice")
    if not isinstance(voice, str) or not VOICE_NAME.fullmatch(voice):
        raise ValueError("invalid voice")

    speed = value.get("speed")
    if (
        isinstance(speed, bool)
        or not isinstance(speed, (int, float))
        or not 0.25 <= float(speed) <= 4.0
    ):
        raise ValueError("speed must be between 0.25 and 4.0")

    output_raw = value.get("output")
    if not isinstance(output_raw, str):
        raise ValueError("output must be a path")
    output = Path(output_raw)
    if (
        not output.is_absolute()
        or not OUTPUT_NAME.fullmatch(output.name)
        or output.suffix != ".wav"
        or not output.parent.is_dir()
    ):
        raise ValueError("output must be an absolute Conch worker WAV path")

    return request_id, text, voice, float(speed), output


def synthesize(model: Any, text: str, voice: str, speed: float, output: Path) -> dict[str, Any]:
    import numpy as np

    started = time.perf_counter()
    chunks: list[Any] = []
    sample_rate: int | None = None
    for result in model.generate(
        text,
        voice=voice,
        speed=speed,
        lang_code="a",
        verbose=False,
    ):
        chunks.append(result.audio)
        if sample_rate is None:
            sample_rate = int(result.sample_rate)

    if not chunks or sample_rate is None:
        raise RuntimeError("Kokoro generated no audio")

    # MLX exposes DLPack.  This avoids mlx_audio.audio_io.write's Python-list
    # round trip while retaining the same mono PCM16 WAV consumed by afplay.
    arrays = [np.from_dlpack(chunk) for chunk in chunks]
    audio = arrays[0] if len(arrays) == 1 else np.concatenate(arrays)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    partial = output.with_name(f"{output.name}.partial-{os.getpid()}")
    try:
        with wave.open(str(partial), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(pcm.tobytes())
        os.replace(partial, output)
    finally:
        try:
            partial.unlink()
        except FileNotFoundError:
            pass

    # Loudness telemetry. Kokoro's output level varies per utterance and we do
    # not normalize, so a short chunk can land noticeably louder than the run of
    # speech around it. Reporting peak and RMS makes that measurable from the
    # log instead of arguable by ear.
    peak = float(np.max(np.abs(audio))) if audio.shape[0] else 0.0
    rms = float(np.sqrt(np.mean(np.square(audio, dtype="float64")))) if audio.shape[0] else 0.0

    return {
        "path": str(output),
        "sample_rate": sample_rate,
        "samples": int(audio.shape[0]),
        "latency_ms": round((time.perf_counter() - started) * 1000, 3),
        "peak": round(peak, 5),
        "rms": round(rms, 5),
    }


def run() -> int:
    args = parse_args()
    voices = parse_voices(args.voices, args.warmup_voice)
    try:
        from mlx_audio.tts.utils import load_model

        load_started = time.perf_counter()
        model = load_model(args.model)
        load_ms = (time.perf_counter() - load_started) * 1000

        warm_started = time.perf_counter()
        warm_chunks = list(
            model.generate(
                "Ready.",
                voice=args.warmup_voice,
                speed=args.warmup_speed,
                lang_code="a",
                verbose=False,
            )
        )
        if not warm_chunks:
            raise RuntimeError("Kokoro warmup generated no audio")
        warmup_ms = (time.perf_counter() - warm_started) * 1000

        emit(
            {
                "type": "ready",
                "protocol": PROTOCOL_VERSION,
                "model": args.model,
                "voices": voices,
                "sample_rate": int(warm_chunks[0].sample_rate),
                "pid": os.getpid(),
                "load_ms": round(load_ms, 3),
                "warmup_ms": round(warmup_ms, 3),
            }
        )
    except BaseException as error:
        traceback.print_exc(file=sys.stderr)
        emit(
            {
                "type": "fatal",
                "protocol": PROTOCOL_VERSION,
                "error": f"{type(error).__name__}: {error}",
            }
        )
        return 1

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        request_id: str | None = None
        try:
            value = json.loads(raw_line)
            if isinstance(value, dict) and isinstance(value.get("id"), str):
                request_id = value["id"]
            request_id, text, voice, speed, output = validate_request(value)
        except (ValueError, json.JSONDecodeError) as error:
            emit(
                {
                    "type": "result",
                    "id": request_id,
                    "ok": False,
                    "kind": "request",
                    "error": f"{type(error).__name__}: {error}",
                }
            )
            continue

        try:
            result = synthesize(model, text, voice, speed, output)
            emit({"type": "result", "id": request_id, "ok": True, **result})
        except BaseException as error:
            traceback.print_exc(file=sys.stderr)
            emit(
                {
                    "type": "result",
                    "id": request_id,
                    "ok": False,
                    "kind": "inference",
                    "error": f"{type(error).__name__}: {error}",
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
