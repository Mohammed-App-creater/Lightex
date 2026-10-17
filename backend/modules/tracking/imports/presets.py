"""Board 40 header → field synonyms and preset detection (§4.7). Twin of the mock's `src/lib/mock/import/presets.ts`;
both follow the shared vectors ("headers", "presets", "suggest")."""

from __future__ import annotations

import re
from typing import Any

_CUSTOM = re.compile(r"^custom field \((.*)\)$", re.DOTALL)
_APOSTROPHES = re.compile(r"[’']")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")

SYNONYMS: dict[str, list[str]] = {
    "title": ["title", "summary", "name", "card name", "task", "task name", "subject", "issue"],
    "description": ["description", "desc", "details", "body", "notes"],
    "status": ["status", "list", "state", "column", "stage", "section", "section column"],
    "assignee": ["assignee", "assignee email", "members", "member", "owner", "assigned to", "assigned"],
    "priority": ["priority", "prio", "severity"],
    "estimate": ["estimate", "story points", "story point estimate", "points", "sp", "estimation", "effort"],
    "timeEstimate": ["original estimate", "time estimate", "estimated time", "time estimate h"],
    "startDate": ["start", "start date", "starts"],
    "dueDate": ["due", "due date", "deadline", "due on", "target date"],
    "labels": ["labels", "tags", "label", "tag"],
    "type": ["type", "issue type", "task type", "kind"],
    "epic": ["epic", "epic link", "epic name"],
    "sprint": ["sprint", "cycle", "cycle name", "iteration"],
    "parent": ["parent", "parent id", "parent issue", "parent task", "parent key"],
    "sourceId": ["id", "key", "issue key", "issue id", "task id", "card id"],
    "blockedBy": ["blocked by", "depends on", "inward issue link blocks"],
    "blocks": ["blocks", "outward issue link blocks"],
}
BY_SYNONYM: dict[str, str] = {s: f for f, names in SYNONYMS.items() for s in names}

FIELDS = (
    "title", "description", "status", "assignee", "priority", "estimate", "dueDate", "labels", "type",
    "timeEstimate", "startDate", "epic", "sprint", "parent", "sourceId", "blockedBy", "blocks", "customField", "skip",
)  # fmt: skip
# Fields that may take several columns (§4.5): Jira repeats Labels; Issue key + Issue id are both IDs.
MULTI_COLUMN = frozenset({"labels", "sourceId", "blockedBy", "blocks", "skip"})
# Select labels (§4.5), used in the "Two columns map to …" blocker.
FIELD_LABELS = {
    "title": "Title",
    "description": "Description",
    "status": "Status",
    "assignee": "Assignee",
    "priority": "Priority",
    "estimate": "Estimate",
    "dueDate": "Due date",
    "labels": "Labels",
    "type": "Type",
    "timeEstimate": "Time estimate",
    "startDate": "Start date",
    "epic": "Epic",
    "sprint": "Sprint",
    "parent": "Parent",
    "sourceId": "ID (for links)",
    "blockedBy": "Blocked by",
    "blocks": "Blocks",
    "customField": "Custom field",
    "skip": "Don’t import",
}
SECONDS_HEADERS = ("original estimate", "remaining estimate")


def norm_header(value: str) -> str:
    """Lower-case, strip a Jira `custom field (…)` wrapper, drop ’ and ', non-alphanumerics → one space, trim."""
    text = str(value or "").lower().strip()
    m = _CUSTOM.match(text)
    if m:
        text = m.group(1)
    return _NON_ALNUM.sub(" ", _APOSTROPHES.sub("", text)).strip()


def field_for_header(header: str) -> str | None:
    return BY_SYNONYM.get(norm_header(header))


def detect_preset(headers: list[str]) -> str:
    """§4.7 presets, first match wins."""
    h = {norm_header(x) for x in headers}
    if {"issue key", "summary", "issue type"} <= h:
        return "jira"
    if {"id", "title"} <= h and ("cycle name" in h or "team" in h):
        return "linear"
    if {"task id", "name", "section column"} <= h:
        return "asana"
    return "generic"


def default_unit(preset: str, header: str) -> str:
    """Bare numbers in a time-estimate column: hours, except Jira's estimates, which are in seconds."""
    return "seconds" if preset == "jira" and norm_header(header) in SECONDS_HEADERS else "hours"


def suggest_columns(raw_header: list[str], preset: str, custom_fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The suggested mapping. Single-column fields: the first matching column wins, later ones are "skip".
    Multi-column fields take every match. A header equal to a project custom field's name maps to that field
    (once). Asana's "Assignee Email" beats "Assignee" (the name column becomes "skip")."""
    norm = [norm_header(h) for h in raw_header]
    email_col = norm.index("assignee email") if "assignee email" in norm else -1
    used: set[str] = set()
    out: list[dict[str, Any]] = []
    for i, n in enumerate(norm):
        fld = BY_SYNONYM.get(n)
        if fld == "assignee" and email_col >= 0 and i != email_col:
            fld = None
        if fld:
            if fld in MULTI_COLUMN:
                out.append({"field": fld})
            elif fld not in used:
                used.add(fld)
                if fld == "timeEstimate":
                    out.append({"field": fld, "unit": default_unit(preset, raw_header[i])})
                else:
                    out.append({"field": fld})
            else:
                out.append({"field": "skip"})
            continue
        cf = next((f for f in custom_fields if norm_header(f["name"]) == n), None)
        if cf is not None and f"cf:{cf['id']}" not in used:
            used.add(f"cf:{cf['id']}")
            out.append({"field": "customField", "customFieldId": cf["id"]})
            continue
        out.append({"field": "skip"})
    return out
