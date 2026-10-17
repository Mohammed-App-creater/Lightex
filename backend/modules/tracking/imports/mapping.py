"""Board 40 value matching and conversion (§4.7): statuses, types, people, priorities, dates, numbers and durations.

Twin of the mock's `src/lib/mock/import/match.ts` and `convert.ts`; both follow the shared vectors.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from collections.abc import Iterable
from typing import Any

# ───────────────────────── keys ─────────────────────────

_SPACES = re.compile(r"\s+")
_APOSTROPHES = re.compile(r"[’']")


def value_key(value: str) -> str:
    """ImportValue.key: trimmed, lower-cased, inner whitespace collapsed."""
    return _SPACES.sub(" ", str(value or "").strip().lower())


def _loose(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", _APOSTROPHES.sub("", str(value or "").lower()))


def js_round(value: float) -> int:
    """JavaScript's Math.round (half up), so both sides round the same way."""
    return math.floor(value + 0.5)


# ───────────────────────── statuses, types, priorities ─────────────────────────

STATUS_SYNONYMS = {
    "backlog": "backlog", "icebox": "backlog",
    "todo": "todo", "open": "todo", "new": "todo",
    "doing": "progress", "inprogress": "progress", "started": "progress", "wip": "progress",
    "review": "review", "inreview": "review", "qa": "review",
    "done": "done", "closed": "done", "complete": "done", "completed": "done", "resolved": "done",
    "wontdo": "canceled", "canceled": "canceled", "cancelled": "canceled",
}  # fmt: skip


def match_status(value: str, statuses: list[dict[str, Any]]) -> str | None:
    """(1) exact name ignoring case and spaces; (2) synonym → glyph → the first status with that glyph by
    position; (3) None (unmapped). `statuses`: [{id, name, glyph, position}]."""
    n = _loose(value)
    if not n:
        return None
    for s in statuses:
        if _loose(s["name"]) == n:
            return str(s["id"])
    glyph = STATUS_SYNONYMS.get(n)
    if glyph is None:
        return None
    for s in sorted(statuses, key=lambda s: s["position"]):
        if s["glyph"] == glyph:
            return str(s["id"])
    return None


TYPE_SYNONYMS = {
    "story": "feature", "task": "feature", "feature": "feature", "new feature": "feature",
    "improvement": "feature", "sub-task": "feature", "subtask": "feature",
    "bug": "bug", "defect": "bug", "incident": "bug",
    "chore": "chore", "maintenance": "chore", "tech debt": "chore",
    "spike": "spike", "research": "spike", "investigation": "spike",
    "epic": "epic",
}  # fmt: skip
TASK_TYPES = ("feature", "bug", "chore", "spike", "epic")


def match_type(value: str, can_epic: bool) -> str | None:
    t = TYPE_SYNONYMS.get(value_key(value))
    if t == "epic" and not can_epic:
        return None
    return t


PRIORITY = {
    "urgent": 4, "highest": 4, "critical": 4, "blocker": 4, "p0": 4,
    "high": 3, "p1": 3,
    "medium": 2, "normal": 2, "p2": 2,
    "low": 1, "lowest": 1, "minor": 1, "trivial": 1, "p3": 1, "p4": 1,
    "none": 0, "no priority": 0,
}  # fmt: skip


def match_priority(value: str) -> int:
    """Fixed synonyms; unknown or empty → 0 ("No priority"), never an issue."""
    return PRIORITY.get(value_key(value), 0)


# ───────────────────────── people ─────────────────────────


def _norm_name(value: str) -> str:
    return re.sub(r"[^a-z0-9@]+", " ", _APOSTROPHES.sub("", str(value or "").lower())).strip()


def first_person(cell: str) -> str:
    """First value of a cell that may list several people (split on , and ;)."""
    return re.split(r"[,;]", str(cell or ""))[0].strip()


def match_person(value: str, members: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    """(target, matchedBy). (1) email; (2) normalised full name; (3) same first name and the second token's
    initial equals the last-name initial ("Sam P.", "jordan.lee"), only when exactly one member matches."""
    v = first_person(value)
    if not v:
        return None, None
    low = v.lower()
    for m in members:
        if str(m["email"]).lower() == low:
            return str(m["id"]), "email"
    n = value_key(v)
    for m in members:
        if value_key(m["name"]) == n:
            return str(m["id"]), "name"
    tokens = [t for t in _norm_name(re.sub(r"[._]", " ", v)).split(" ") if t]
    if len(tokens) > 1:
        hits = []
        for m in members:
            parts = [p for p in _norm_name(m["name"]).split(" ") if p]
            if len(parts) > 1 and parts[0] == tokens[0] and parts[-1][0] == tokens[1][0]:
                hits.append(m)
        if len(hits) == 1:
            return str(hits[0]["id"]), "initial"
    return None, None


# ───────────────────────── dates ─────────────────────────

MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
FULL_MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
]  # fmt: skip

_ISO = re.compile(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ].*)?", re.ASCII)
_SLASH = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})(?:[ T].*)?", re.ASCII)
_DOT = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:[ T].*)?", re.ASCII)
_JIRA = re.compile(r"(\d{1,2})/([A-Za-z]{3})/(\d{2}|\d{4})(?:\s+\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?)?", re.ASCII)
_MDY_TEXT = re.compile(r"([A-Za-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})(?:\s+.*)?", re.ASCII)
_DMY_TEXT = re.compile(r"(\d{1,2})\s+([A-Za-z]+\.?),?\s+(\d{4})(?:\s+.*)?", re.ASCII)


def _month(name: str) -> int | None:
    n = name.lower().removesuffix(".")
    if n in MONTHS:
        return MONTHS.index(n) + 1
    if n in FULL_MONTHS:
        return FULL_MONTHS.index(n) + 1
    return 9 if n == "sept" else None


def iso_of(y: int, m: int, d: int) -> str | None:
    """A real calendar date as YYYY-MM-DD, or None (2026-02-30 is impossible)."""
    if not 1000 <= y <= 9999:
        return None
    try:
        return dt.date(y, m, d).isoformat()
    except ValueError:
        return None


def _year(s: str) -> int:
    return 2000 + int(s) if len(s) == 2 else int(s)


def _kind(t: str) -> str | None:
    if _ISO.fullmatch(t):
        return "iso"
    if _JIRA.fullmatch(t):
        return "jira"
    if _SLASH.fullmatch(t):
        return "slash"
    if _DOT.fullmatch(t):
        return "dot"
    if _MDY_TEXT.fullmatch(t) or _DMY_TEXT.fullmatch(t):
        return "text"
    return None


def date_order_of(values: Iterable[str]) -> str | None:
    """A column's date order (§4.3 `dateOrder`) from its values: the most common pattern; numeric slashes are
    `mdy` unless some value's first part is > 12 (→ `dmy`); dots → `dmy`. None when nothing looks like a date."""
    counts: dict[str, int] = {}
    first_over_12 = False
    for raw in values:
        t = raw.strip()
        if not t:
            continue
        k = _kind(t)
        if k is None:
            continue
        counts[k] = counts.get(k, 0) + 1
        if k == "slash":
            m = _SLASH.fullmatch(t)
            if m and int(m.group(1)) > 12:
                first_over_12 = True
    if not counts:
        return None
    top = sorted(counts.items(), key=lambda kv: -kv[1])[0][0]
    return {"iso": "ymd", "jira": "jira", "text": "text", "dot": "dmy"}.get(top) or ("dmy" if first_over_12 else "mdy")


def parse_date(raw: str, order: str | None = None) -> str | None:
    """A date cell → YYYY-MM-DD or None. ISO, Jira and month names read in any column; numeric slashes follow
    the column order (`dmy` when the column says so, else `mdy`); dots are day-first. A time part is ignored."""
    t = str(raw or "").strip()
    if not t:
        return None
    if m := _ISO.fullmatch(t):
        return iso_of(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    if m := _JIRA.fullmatch(t):
        month = _month(m.group(2))
        return iso_of(_year(m.group(3)), month, int(m.group(1))) if month else None
    if m := _SLASH.fullmatch(t):
        a, b = int(m.group(1)), int(m.group(2))
        return iso_of(_year(m.group(3)), b, a) if order == "dmy" else iso_of(_year(m.group(3)), a, b)
    if m := _DOT.fullmatch(t):
        return iso_of(_year(m.group(3)), int(m.group(2)), int(m.group(1)))
    if m := _MDY_TEXT.fullmatch(t):
        month = _month(m.group(1))
        return iso_of(int(m.group(3)), month, int(m.group(2))) if month else None
    if m := _DMY_TEXT.fullmatch(t):
        month = _month(m.group(2))
        return iso_of(int(m.group(3)), month, int(m.group(1))) if month else None
    return None


# ───────────────────────── numbers and durations ─────────────────────────

_DECIMAL_COMMA = re.compile(r"-?\d+,\d+", re.ASCII)
_PLAIN = re.compile(r"-?\d+(\.\d+)?", re.ASCII)
_THOUSANDS_COMMA = re.compile(r"-?\d{1,3}(,\d{3})+(\.\d+)?", re.ASCII)
_THOUSANDS_SPACE = re.compile(r"-?\d{1,3}( \d{3})+(\.\d+)?", re.ASCII)


def parse_number(raw: str, delimiter: str = ",") -> float | None:
    """ "1240", "1,240", "1 240", "12.5"; with ";" as the file delimiter "12,5" is 12.5. None otherwise."""
    t = str(raw or "").strip()
    if not t:
        return None
    if delimiter == ";" and _DECIMAL_COMMA.fullmatch(t):
        return float(t.replace(",", "."))
    if _PLAIN.fullmatch(t):
        return float(t)
    if _THOUSANDS_COMMA.fullmatch(t):
        return float(t.replace(",", ""))
    if _THOUSANDS_SPACE.fullmatch(t):
        return float(t.replace(" ", ""))
    return None


_CLOCK = re.compile(r"(\d{1,2}):([0-5]\d)", re.ASCII)
_BARE = re.compile(r"(\d+(?:\.\d+)?)", re.ASCII)
_UNITS = re.compile(r"(?:(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?)?\s*(?:(\d+)\s*m(?:in(?:s|utes?)?)?)?", re.ASCII)


def parse_duration(raw: str) -> int | None:
    """Board 39 §6.6 grammar: "1:30", bare number (≤ 12 = hours, else minutes), "1h 30m", "90m", "1.5h",
    "2 hours 5 mins". None when unreadable."""
    t = str(raw or "").strip().lower()
    if not t:
        return None
    if m := _CLOCK.fullmatch(t):
        return int(m.group(1)) * 60 + int(m.group(2))
    if m := _BARE.fullmatch(t):
        n = float(m.group(1))
        return js_round(n * 60 if n <= 12 else n)
    m = _UNITS.fullmatch(t)
    if m is None or (not m.group(1) and not m.group(2)):
        return None
    hours = float(m.group(1)) * 60 if m.group(1) else 0.0
    return js_round(hours + (int(m.group(2)) if m.group(2) else 0))


def parse_duration_cell(raw: str, unit: str = "hours") -> int | None:
    """Time estimate in minutes: the board 39 grammar, except that a bare number uses the column's unit.
    None = unreadable; 0 = no estimate."""
    t = str(raw or "").strip()
    if not t:
        return 0
    bare = parse_number(t)
    if bare is not None:
        if bare < 0:
            return None
        return js_round(bare / 60 if unit == "seconds" else bare if unit == "minutes" else bare * 60)
    return parse_duration(t)


def round_half_up(value: float) -> int:
    """Story points round half up (v1 `_estimate`)."""
    return math.floor(value + 0.5)


# ───────────────────────── column types (analysis) ─────────────────────────

_EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
_LIST = re.compile(r";|, ")
_LETTER = re.compile(r"[a-z]", re.IGNORECASE)


def infer_type(values: list[str], member_names: set[str]) -> str:
    """§4.3 `inferredType` (drives suggestions only, never rejects)."""
    filled = [v.strip() for v in values if v.strip()]
    if not filled:
        return "empty"

    def share(pred) -> float:
        return sum(1 for v in filled if pred(v)) / len(filled)

    if share(lambda v: parse_number(v) is not None) == 1:
        return "number"
    if share(lambda v: parse_date(v) is not None) >= 0.8:
        return "date"
    if share(lambda v: bool(_LETTER.search(v)) and parse_duration(v) is not None) >= 0.8:
        return "duration"
    if share(lambda v: bool(_EMAIL.fullmatch(v)) or v.lower() in member_names) >= 0.8:
        return "person"
    if share(lambda v: bool(_LIST.search(v))) >= 0.3:
        return "list"
    return "text"
