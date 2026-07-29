#!/usr/bin/env python3
"""Stdlib-only JSONL peer for ManagedTtsWorker integration tests."""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
import wave
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = 1
SAMPLE_RATE = 16_000
SAMPLES = 160


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--record", required=True)
    parser.add_argument("--malformed-ready", action="store_true")
    return parser.parse_args()


def emit(payload: dict[str, Any]) -> None:
    print(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        flush=True,
    )


def write_wav(path: Path) -> None:
    frames = b"".join(
        struct.pack("<h", 1_000 if index % 2 == 0 else -1_000)
        for index in range(SAMPLES)
    )
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(frames)


def hang() -> None:
    while True:
        time.sleep(60)


def run() -> int:
    args = parse_args()
    emit(
        {
            "type": "ready",
            "protocol": PROTOCOL_VERSION,
            "model": args.model,
            "voices": [None] if args.malformed_ready else ["af_heart", "am_adam"],
            "sample_rate": SAMPLE_RATE,
            "pid": os.getpid(),
            "load_ms": 1,
            "warmup_ms": 1,
        }
    )

    for raw_line in sys.stdin:
        frame = json.loads(raw_line)
        with open(args.record, "a", encoding="utf-8") as record:
            record.write(
                json.dumps(
                    {"mock_pid": os.getpid(), "request": frame},
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n"
            )
            record.flush()

        text = frame.get("text")
        if text == "__crash__":
            os._exit(23)

        output = Path(frame["output"])
        if text == "__write_then_hang__":
            write_wav(output)
            hang()
        if text == "__hang__":
            hang()

        write_wav(output)
        if text == "__malformed_result__":
            emit(
                {
                    "type": "result",
                    "id": frame["id"],
                    "ok": True,
                    "path": str(output),
                    "sample_rate": SAMPLE_RATE,
                    "samples": -1,
                    "latency_ms": 1,
                }
            )
            continue
        emit(
            {
                "type": "result",
                "id": frame["id"],
                "ok": True,
                "path": str(output),
                "sample_rate": SAMPLE_RATE,
                "samples": SAMPLES,
                "latency_ms": 1,
            }
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
