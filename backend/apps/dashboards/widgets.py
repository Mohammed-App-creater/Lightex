"""Widget catalogue (docs/v2/33-dashboards-presence.md §1.3, §3.3), mirroring the web client's
src/lib/domain/dashboards.ts: types, default sizes, minimum heights, the permission each type needs, per-type
config schemas, and the first-fit packing used by the client (shared vectors: tests/pack_vectors.json)."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

WIDGET_TYPES = ("burndown", "my_tasks", "objectives", "workload", "velocity", "activity")
WIDGET_NAME = {
    "burndown": "Burndown",
    "my_tasks": "My tasks",
    "objectives": "Objective progress",
    "workload": "Workload by person",
    "velocity": "Velocity",
    "activity": "Recent activity",
}
DEFAULT_SIZE = {
    "burndown": (6, 2),
    "my_tasks": (3, 2),
    "objectives": (3, 2),
    "workload": (6, 2),
    "velocity": (3, 2),
    "activity": (3, 2),
}
MIN_H = {"burndown": 2, "my_tasks": 1, "objectives": 1, "workload": 2, "velocity": 2, "activity": 1}
MIN_W, MAX_W, MAX_H, COLS = 3, 12, 4, 12
MAX_WIDGETS = len(WIDGET_TYPES)
WIDGET_NEEDS = {
    "burndown": "report.view",
    "my_tasks": "project.view",
    "objectives": "report.view",
    "workload": "report.view",
    "velocity": "report.view",
    "activity": "project.view",
}
#: "Sprint health" template (§1.6): the design's default layout, in order.
SPRINT_HEALTH = WIDGET_TYPES
MAX_QUARTER = 16


def default_config(widget_type: str) -> dict[str, Any]:
    defaults: dict[str, dict[str, Any]] = {
        "burndown": {"sprintId": None},
        "my_tasks": {"showDone": True},
        "objectives": {"quarter": None},
        "workload": {"unit": "points", "sprintId": None, "personField": None},
        "velocity": {"range": "last6"},
        "activity": {},
    }
    return defaults[widget_type]


class Refs:
    """The ids a config may reference in one project (sprints, Person custom fields), loaded once per request."""

    def __init__(self, sprint_ids: Iterable[Any], person_field_ids: Iterable[Any]):
        self.sprints = {str(i) for i in sprint_ids}
        self.person_fields = {str(i) for i in person_field_ids}

    @classmethod
    def for_project(cls, project: Any) -> Refs:
        from apps.planning.models import Sprint
        from apps.projects.models import CustomField

        return cls(
            Sprint.objects.filter(project=project).values_list("pk", flat=True),
            CustomField.objects.filter(project=project, type="user").values_list("pk", flat=True),
        )


def clean_config(widget_type: str, raw: Any, refs: Refs, path: str, errors: dict[str, str]) -> dict[str, Any]:
    """Validates one widget's config: unknown keys are dropped, missing keys take defaults, the result is complete."""
    c = raw if isinstance(raw, dict) else {}

    def sprint(key: str) -> Any:
        value = c.get(key)
        if value is not None and (not isinstance(value, str) or value not in refs.sprints):
            errors[f"{path}.{key}"] = "Pick a sprint from this project"
        return value

    if widget_type == "burndown":
        return {"sprintId": sprint("sprintId")}
    if widget_type == "my_tasks":
        show = c.get("showDone", True)
        if not isinstance(show, bool):
            errors[f"{path}.showDone"] = "Use true or false"
        return {"showDone": show is not False}
    if widget_type == "objectives":
        quarter = c.get("quarter")
        if quarter is not None and (not isinstance(quarter, str) or len(quarter) > MAX_QUARTER):
            errors[f"{path}.quarter"] = "Up to 16 characters"
        return {"quarter": quarter if isinstance(quarter, str) else None}
    if widget_type == "workload":
        unit = c.get("unit", "points")
        if unit not in ("points", "hours"):
            errors[f"{path}.unit"] = "Pick points or hours"
        sprint_id = sprint("sprintId")
        person = c.get("personField")
        if person is not None and (not isinstance(person, str) or person not in refs.person_fields):
            errors[f"{path}.personField"] = "Pick a person field from this project"
        return {"unit": "hours" if unit == "hours" else "points", "sprintId": sprint_id, "personField": person}
    if widget_type == "velocity":
        range_ = c.get("range", "last6")
        if range_ not in ("last2", "last6"):
            errors[f"{path}.range"] = "Pick last2 or last6"
        return {"range": "last2" if range_ == "last2" else "last6"}
    return {}


def read_config(widget_type: str, stored: Any, refs: Refs) -> dict[str, Any]:
    """The config as served: complete, and a reference to a deleted sprint or field falls back to the default."""
    config = {
        **default_config(widget_type),
        **{k: v for k, v in (stored or {}).items() if k in default_config(widget_type)},
    }
    if config.get("sprintId") is not None and str(config["sprintId"]) not in refs.sprints:
        config["sprintId"] = None
    if config.get("personField") is not None and str(config["personField"]) not in refs.person_fields:
        config["personField"] = None
    return config


def pack(items: Iterable[tuple[int, int]], cols: int = COLS) -> list[dict[str, int]]:
    """First-fit packing, a port of the design's pack(): for each (w, h) in order, the first row, then the first
    column, where the box fits without overlap. Widths above `cols` are clamped."""
    occupied: set[tuple[int, int]] = set()
    rects = []
    for raw_w, raw_h in items:
        w, h = max(1, min(cols, raw_w)), max(1, raw_h)
        y = 0
        while True:
            x = next(
                (
                    x
                    for x in range(cols - w + 1)
                    if not any((r, c) in occupied for r in range(y, y + h) for c in range(x, x + w))
                ),
                None,
            )
            if x is not None:
                occupied.update((r, c) for r in range(y, y + h) for c in range(x, x + w))
                rects.append({"x": x, "y": y, "w": w, "h": h})
                break
            y += 1
    return rects
