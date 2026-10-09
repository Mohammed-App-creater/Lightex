"""Board 40 error report (§5.7): UTF-8 with BOM, CRLF, every field quoted and formula-safe (§7.1).

Columns: Row, Outcome, Reason, Value, then every original column under the file's header names, so a user can fix
the skipped rows and import the report itself (its first four columns are suggested as "Don't import"). One line
per issue; skips first, then warnings, each by row.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from apps.common.csvsafe import csv_document


def ordered_issues(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Skips first, then warnings, each by row; duplicates (same row, severity and reason) dropped."""
    seen: set[tuple[Any, ...]] = set()
    out = []
    for issue in issues:
        k = (issue["row"], issue["severity"], issue["reason"])
        if k in seen:
            continue
        seen.add(k)
        out.append(issue)
    return sorted(out, key=lambda i: (0 if i["severity"] == "skip" else 1, i["row"]))


def build_report(header: list[str], rows: list[list[str]], issues: list[dict[str, Any]]) -> str:
    """The whole report file, BOM included. `issues` carry their spreadsheet `row` (header = 1)."""
    lines: list[list[Any]] = [["Row", "Outcome", "Reason", "Value", *header]]
    blank = [""] * len(header)
    for i in ordered_issues(issues):
        source = rows[i["row"] - 2] if 0 <= i["row"] - 2 < len(rows) else blank
        outcome = "Skipped" if i["severity"] == "skip" else "Imported with changes"
        lines.append([i["row"], outcome, i["reason"], i.get("value", ""), *source])
    return csv_document(lines, bom=True)


def report_file_name(project_key: str, finished_at: dt.datetime | None) -> str:
    """import-errors-prj-2026-10-09.csv (project key lower-case, finish date UTC)."""
    day = (finished_at or dt.datetime.now(dt.UTC)).astimezone(dt.UTC).date().isoformat()
    return f"import-errors-{project_key.lower()}-{day}.csv"
