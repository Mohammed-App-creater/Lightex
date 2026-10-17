"""Board 40 file reading (§7.2–7.4): encoding detection, delimiter sniffing and a small RFC 4180 reader.

Identical on both sides: the web client's mock (`src/lib/mock/import/decode.ts`, `csv.ts`) and this module follow
the shared vectors in `tests/data/import_vectors.json`. The reader is hand-written rather than Python's `csv`
module because the vectors fix behaviour `csv` can't give in one mode: lenient text after a closing quote
(`"ab"c` → `abc`, like `strict=False`) *and* an "Unclosed quote" error with the line where the quote opened.
It scans field by field with regular expressions, so a 10 MB file reads in well under a second.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

DELIMITERS = (",", ";", "\t", "|")
MAX_COLUMNS = 40
MAX_CELL = 65_536
MAX_HEADER = 60

_C0 = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_QUOTED = re.compile(r'"((?:[^"]++|"")*+)"')
_NEWLINES = re.compile(r"\r(?!\n)|\n")
_UNQUOTED = {d: re.compile(f"[^{re.escape(d)}\r\n]*") for d in DELIMITERS}


class ParseError(Exception):
    """An analysis error (§4.3): `reason` plus machine detail (line, columns, rows…)."""

    def __init__(self, reason: str, **detail: Any) -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail

    def as_dict(self) -> dict[str, Any]:
        return {"reason": self.reason, **self.detail}


# ───────────────────────── encoding (§7.2) ─────────────────────────


def decode_bytes(data: bytes) -> tuple[str, str]:
    """(text, encoding). Raises ParseError("excel") for a ZIP/OLE signature, ParseError("binary") for NULs."""
    if data.startswith((b"PK\x03\x04", b"\xd0\xcf\x11\xe0")):
        raise ParseError("excel")
    if data.startswith(b"\xef\xbb\xbf"):
        text, encoding = data[3:].decode("utf-8", errors="replace"), "utf-8"
    elif data.startswith((b"\xff\xfe", b"\xfe\xff")):
        body = data[2:]
        body = body[: len(body) - len(body) % 2]
        codec = "utf-16-le" if data.startswith(b"\xff\xfe") else "utf-16-be"
        text, encoding = body.decode(codec, errors="replace"), "utf-16"
    else:
        try:
            text, encoding = data.decode("utf-8"), "utf-8"
        except UnicodeDecodeError:
            # Windows-1252; the five undefined bytes become U+FFFD.
            text, encoding = data.decode("cp1252", errors="replace"), "windows-1252"
    if "\x00" in text:
        raise ParseError("binary")
    return text, encoding


# ───────────────────────── records ─────────────────────────


@dataclass
class Records:
    records: list[tuple[list[str], int]] = field(default_factory=list)  # (cells, physical line it starts on)
    quote_line: int = 0  # line where an unclosed quote opened, else 0
    too_long: int = 0  # line of the first record with a cell over the limit, else 0


def read_records(text: str, delim: str, limit: int | None = None, cell_limit: int | None = MAX_CELL) -> Records:
    """Splits `text` into records. Quotes open only at the start of a field; "" inside quotes is a quote; CR, LF
    and CRLF end a record; newlines inside quotes are kept; completely empty lines are ignored; text after a
    closing quote is kept (`"ab"c` → `abc`). `limit` stops after that many records (sniffing)."""
    out = Records()
    unquoted = _UNQUOTED[delim]
    n = len(text)
    pos = 0
    line = 1
    while pos < n:
        rec_line = line
        row: list[str] = []
        content = False
        while True:
            if pos < n and text[pos] == '"':
                m = _QUOTED.match(text, pos)
                if m is None:
                    out.quote_line = line
                    return out
                value = m.group(1).replace('""', '"')
                line += len(_NEWLINES.findall(m.group(1)))
                tail = unquoted.match(text, m.end())
                assert tail is not None  # noqa: S101 - a `*` pattern always matches
                value += tail.group(0)
                pos = tail.end()
                content = True
            else:
                m = unquoted.match(text, pos)
                assert m is not None  # noqa: S101
                value = m.group(0)
                pos = m.end()
                content = content or bool(value)
            if cell_limit is not None and not out.too_long and len(value) > cell_limit:
                out.too_long = rec_line
            row.append(value)
            if pos < n and text[pos] == delim:
                pos += 1
                content = True
                continue
            break
        # End of record: a line break or the end of the text.
        if pos < n:
            pos += 2 if text.startswith("\r\n", pos) else 1
        if content:
            out.records.append((row, rec_line))
            if limit is not None and len(out.records) >= limit:
                return out
        line += 1
    return out


def sniff_delimiter(text: str) -> str:
    """§7.3: the candidate whose first 20 records most often have the first record's field count (> 1); ties
    go to more fields in the first record, then to the order , ; tab |. No candidate with > 1 field → ","."""
    best: tuple[int, int] | None = None
    choice = ","
    for d in DELIMITERS:
        records = read_records(text, d, limit=20, cell_limit=None).records
        width = len(records[0][0]) if records else 0
        if width <= 1:
            continue
        score = sum(1 for cells, _ in records if len(cells) == width)
        if best is None or (score, width) > best:
            best = (score, width)
            choice = d
    return choice


def strip_controls(value: str) -> str:
    """C0 control characters except tab and newline are removed from every value (§4.7 "Text")."""
    return _C0.sub("", value)


def normalise_header(raw: list[str]) -> list[str]:
    """First 60 characters, blank → "Column 4", duplicates → "Labels (2)" (design)."""
    seen: dict[str, int] = {}
    out = []
    for k, h in enumerate(raw):
        name = strip_controls(h).strip()[:MAX_HEADER] or f"Column {k + 1}"
        low = name.lower()
        seen[low] = seen.get(low, 0) + 1
        if seen[low] > 1:
            name = f"{name} ({seen[low]})"
        out.append(name)
    return out


@dataclass
class ParsedFile:
    header: list[str]  # display names (cut, blank-filled, de-duplicated)
    raw_header: list[str]  # header cells as written (trimmed), for synonym matching
    rows: list[list[str]]  # padded / cut to the header width, control characters stripped
    delimiter: str = ","

    def to_json(self) -> dict[str, Any]:
        return {
            "v": 1,
            "header": self.header,
            "rawHeader": self.raw_header,
            "delimiter": self.delimiter,
            "rows": self.rows,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ParsedFile:
        return cls(
            header=list(data["header"]),
            raw_header=list(data.get("rawHeader") or data["header"]),
            rows=[list(r) for r in data["rows"]],
            delimiter=data.get("delimiter") or ",",
        )


def parse_csv(text: str, delim: str, max_rows: int) -> ParsedFile:
    """Parses a decoded file with a known delimiter and applies the §1.5 limits (raises ParseError)."""
    found = read_records(text, delim)
    if found.quote_line:
        raise ParseError("unclosed_quote", line=found.quote_line)
    if found.too_long:
        raise ParseError("cell_too_long", line=found.too_long)
    records = found.records
    if not records:
        raise ParseError("no_rows")
    head = records[0][0]
    if len(head) > MAX_COLUMNS:
        raise ParseError("too_many_columns", columns=len(head), max=MAX_COLUMNS)
    if len(records) == 1:
        raise ParseError("header_only")
    if len(records) - 1 > max_rows:
        raise ParseError("too_many_rows", rows=len(records) - 1, max=max_rows)
    width = len(head)
    rows = []
    for cells, _ in records[1:]:
        cells = cells[:width] + [""] * (width - len(cells))
        rows.append([strip_controls(c) for c in cells])
    return ParsedFile(
        header=normalise_header(head),
        raw_header=[strip_controls(h).strip() for h in head],
        rows=rows,
        delimiter=delim,
    )


def read_file(data: bytes, max_rows: int) -> tuple[ParsedFile, str]:
    """Bytes → (parsed file, encoding). Raises ParseError with the §4.3 reason."""
    if not data:
        raise ParseError("empty")
    text, encoding = decode_bytes(data)
    return parse_csv(text, sniff_delimiter(text), max_rows), encoding
