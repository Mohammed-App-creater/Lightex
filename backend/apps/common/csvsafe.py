"""Formula-safe CSV output (board 40 §7.1), shared by every CSV the API writes.

Spreadsheet apps evaluate cells that start with = + - @ (and tab / CR / LF, and their full-width forms), even
when the value came from a user. `csv_safe` prefixes such cells with an apostrophe (also after leading spaces),
then always quotes the field and doubles inner quotes. The web client's twin is
`src/lib/mock/import/report.ts`; both follow `apps/imports/tests/data/import_vectors.json` ("csvSafe").
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

TRIGGERS = frozenset("=+-@\t\r\n＝＋－＠")
BOM = "﻿"


def csv_safe(value: Any) -> str:
    """One CSV field: always quoted, inner quotes doubled, formula triggers neutralised."""
    text = "" if value is None else str(value)
    first = text.lstrip(" ")[:1]
    if first and first in TRIGGERS:
        text = "'" + text
    return '"' + text.replace('"', '""') + '"'


def csv_line(cells: Iterable[Any]) -> str:
    return ",".join(csv_safe(c) for c in cells)


def csv_document(rows: Iterable[Iterable[Any]], *, bom: bool = True) -> str:
    """A whole file: every field quoted and formula-safe (header row included), CRLF line ends, UTF-8 BOM
    by default so Excel opens it as UTF-8."""
    body = "".join(csv_line(row) + "\r\n" for row in rows)
    return (BOM if bom else "") + body
