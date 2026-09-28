"""conch's voice e2e: the few numpy calls src/tts-worker.py makes, over plain lists, so the real worker runs on the
system Python with nothing installed (scripts/voice-heal-e2e.ts). Nothing else, and never shipped."""
from __future__ import annotations

import array as _array
import builtins as _builtins
import math as _math

float32 = "float32"
float64 = "float64"


class ndarray:
    def __init__(self, values) -> None:
        self._values = [float(value) for value in values]

    def reshape(self, *_shape):
        return self

    @property
    def size(self) -> int:
        return len(self._values)

    @property
    def shape(self):
        return (len(self._values),)

    def all(self) -> bool:
        return all(self._values)

    def __mul__(self, factor):
        return ndarray(value * factor for value in self._values)

    def astype(self, _kind):
        return _Int16(self._values)


class _Int16:
    def __init__(self, values) -> None:
        self._values = [int(value) for value in values]

    def tobytes(self) -> bytes:
        return _array.array("h", self._values).tobytes()


def _values(thing):
    return thing._values if isinstance(thing, ndarray) else list(thing)


def array(values, dtype=None):
    return ndarray(_values(values))


def isfinite(values):
    return ndarray(1.0 if _math.isfinite(value) else 0.0 for value in _values(values))


def concatenate(arrays):
    return ndarray(value for part in arrays for value in _values(part))


def clip(values, low, high):
    return ndarray(_builtins.min(high, _builtins.max(low, value)) for value in _values(values))


def abs(values):
    return ndarray(_math.fabs(value) for value in _values(values))


def max(values):
    return _builtins.max(_values(values))


def square(values, dtype=None):
    return ndarray(value * value for value in _values(values))


def mean(values):
    items = _values(values)
    return sum(items) / len(items) if items else 0.0


def sqrt(value):
    return _math.sqrt(value)
