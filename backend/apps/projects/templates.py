"""Workflow templates (statuses created with a project), identical to the client's project-templates.ts."""

from __future__ import annotations

GLYPH_CATEGORY = {
    "backlog": "todo",
    "todo": "todo",
    "progress": "in_progress",
    "review": "in_progress",
    "done": "done",
    "canceled": "done",
}
CATEGORY_GLYPH = {"todo": "todo", "in_progress": "progress", "done": "done"}

TEMPLATES: dict[str, list[tuple[str, str]]] = {
    "simple": [("todo", "Todo"), ("progress", "In progress"), ("done", "Done")],
    "scrum": [
        ("backlog", "Backlog"),
        ("todo", "Todo"),
        ("progress", "In progress"),
        ("review", "In review"),
        ("done", "Done"),
        ("canceled", "Canceled"),
    ],
    "kanban": [
        ("backlog", "Backlog"),
        ("todo", "Ready"),
        ("progress", "Doing"),
        ("review", "Review"),
        ("done", "Done"),
    ],
    "bugs": [
        ("backlog", "Triage"),
        ("todo", "Confirmed"),
        ("progress", "Fixing"),
        ("review", "Verifying"),
        ("done", "Fixed"),
        ("canceled", "Won’t fix"),
    ],
}
DEFAULT_TEMPLATE = "kanban"

DEFAULT_LABELS = [
    ("frontend", "var(--low)"),
    ("backend", "var(--accent-t)"),
    ("bug", "var(--danger)"),
    ("design", "var(--warn)"),
]


def statuses_for(template: str) -> list[dict[str, str]]:
    return [
        {"glyph": glyph, "name": name, "category": GLYPH_CATEGORY[glyph]}
        for glyph, name in TEMPLATES.get(template, TEMPLATES[DEFAULT_TEMPLATE])
    ]
