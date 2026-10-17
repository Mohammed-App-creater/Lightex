"""Audit filter groups: the workspace audit view's `filter[entity]` buckets, contributed by core and modules.

    register_audit_group("task", ["tracking.task"])

Rows whose target type is in no group fall under `workspace`.
"""

from __future__ import annotations

_GROUPS: dict[str, list[str]] = {}


def register_audit_group(group: str, target_types: list[str]) -> None:
    types = _GROUPS.setdefault(group, [])
    types.extend(t for t in target_types if t not in types)


def groups() -> dict[str, list[str]]:
    return {g: list(types) for g, types in _GROUPS.items()}


def grouped_types() -> list[str]:
    return [t for types in _GROUPS.values() for t in types]


register_audit_group("task", ["core.attachment"])
register_audit_group("comment", ["core.comment"])
register_audit_group("member", ["core.member"])
register_audit_group("role", ["core.role"])
