"""Base-62 fractional indexing, identical to the web client's src/lib/utils/fractional-index.ts.

Keys compare with plain byte order (the DB column uses the "C" collation), a key strictly
between any two keys always exists, and keys never end in "0".
"""

from __future__ import annotations

import re

DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
KEY_RE = re.compile(r"^[0-9A-Za-z]{1,64}$")
# Above this length a column is rebalanced so keys stay short.
REBALANCE_LENGTH = 24


def _midpoint(a: str, b: str | None) -> str:
    if b is not None and a >= b:
        raise ValueError(f"fractional-index: {a} >= {b}")
    if a.endswith("0") or (b is not None and b.endswith("0")):
        raise ValueError("fractional-index: trailing zero")
    if b:
        n = 0
        while (a[n] if n < len(a) else "0") == b[n]:
            n += 1
        if n > 0:
            return b[:n] + _midpoint(a[n:], b[n:])
    digit_a = DIGITS.index(a[0]) if a else 0
    digit_b = DIGITS.index(b[0]) if b is not None else len(DIGITS)
    if digit_b - digit_a > 1:
        # JS Math.round(x.5) rounds up; mirror it so both sides produce the same keys.
        return DIGITS[int((digit_a + digit_b) / 2 + 0.5)]
    if b and len(b) > 1:
        return b[:1]
    return DIGITS[digit_a] + _midpoint(a[1:], None)


def key_between(a: str | None, b: str | None) -> str:
    return _midpoint(a or "", b)


def keys_between(a: str | None, b: str | None, n: int) -> list[str]:
    out: list[str] = []
    prev = a
    for _ in range(n):
        k = key_between(prev, b)
        out.append(k)
        prev = k
    return out


def evenly_spaced(n: int) -> list[str]:
    """n short, well-spaced keys (used by rebalancing and seeding)."""
    if n <= 0:
        return []
    width = 1
    while len(DIGITS) ** width - 1 < n * 2:
        width += 1
    space = len(DIGITS) ** width
    step = space // (n + 1)
    out = []
    for i in range(1, n + 1):
        v = step * i
        digits = []
        for _ in range(width):
            digits.append(DIGITS[v % len(DIGITS)])
            v //= len(DIGITS)
        key = "".join(reversed(digits)).rstrip("0") or DIGITS[1]
        out.append(key)
    return out


def keys_after(last: str | None, n: int) -> list[str]:
    """n short, increasing keys after `last` (the end of a column), for appending many rows at once.

    Repeated `key_between(prev, None)` grows a key by one character every few steps; this spreads the n keys
    over a small slice (about 1/62) of the space after `last` instead, using the fewest digits that leave
    room, so a column can take many batches before its keys get longer.
    """
    if n <= 0:
        return []
    base = len(DIGITS)
    last = last or ""
    width = max(len(last), 1)
    while True:
        space = base**width
        low = 0
        for ch in last.ljust(width, "0"):
            low = low * base + DIGITS.index(ch)
        room = space - 1 - low
        if room >= n * base:
            break
        width += 1
    step = max(1, room // (n * base))
    out = []
    for i in range(1, n + 1):
        v = low + step * i
        digits = []
        for _ in range(width):
            digits.append(DIGITS[v % base])
            v //= base
        out.append("".join(reversed(digits)).rstrip("0"))
    return out


def is_valid_key(key: object) -> bool:
    return isinstance(key, str) and bool(KEY_RE.match(key)) and not key.endswith("0")
