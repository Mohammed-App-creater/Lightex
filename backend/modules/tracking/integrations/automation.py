"""Automations as a system actor (docs/v2/37-integrations-github-gitlab.md §7.10).

`apply()` moves each linked task through the normal `tasks.services.update_task` path (version bump, history with
`changed_by = NULL`, completed/started dates, position, search vector, the `status_change` event with
`payload.via`, the audit row with `actor_kind = "integration"`, realtime through the audit hook). Forward-only:
`branch_created`/`pr_opened` only from the todo category; `pr_merged` only when no other visible PR of the task is
still open, and never from done.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from django.db import transaction

from .models import PROVIDER_NAME, AutomationRule

TRIGGERS = ("branch_created", "pr_opened", "pr_merged")


@dataclass(frozen=True)
class IntegrationActor:
    """The audit/notification actor for integration writes (`core.audit.services` reads these attributes)."""

    name: str
    ref: str
    provider: str
    actor_kind: str = "integration"
    source: str = "webhook"
    pk: None = None

    @classmethod
    def of(cls, integration: Any) -> IntegrationActor:
        return cls(PROVIDER_NAME.get(integration.provider, "GitHub"), str(integration.pk), integration.provider)


def apply(ctx: Any, trigger: str, rows: list[Any], ref: str) -> int:
    """Runs `trigger` for the tasks of `rows` (visible link rows). Returns how many tasks moved."""
    from modules.tracking.tasks.models import ExternalLink, Task
    from modules.tracking.tasks.services import update_task

    moved = 0
    seen: set[Any] = set()
    for row in rows:
        if row.suppressed or row.task_id in seen:
            continue
        seen.add(row.task_id)
        task = Task.objects.select_related("project", "status").filter(pk=row.task_id).first()
        if task is None or task.project.deleted_at is not None or task.project.status == "archived":
            continue
        rule = (
            AutomationRule.objects.filter(project_id=task.project_id, trigger=trigger, enabled=True)
            .select_related("status")
            .first()
        )
        if rule is None or rule.status_id == task.status_id:
            continue
        category = task.status.category
        if trigger in ("branch_created", "pr_opened") and category != "todo":
            continue
        if trigger == "pr_merged":
            if category == "done":
                continue
            others_open = (
                ExternalLink.objects.filter(
                    task=task, type="pull_request", suppressed=False, state__in=("open", "draft")
                )
                .exclude(external_id=row.external_id)
                .exists()
            )
            if others_open:
                continue
        with transaction.atomic():
            update_task(
                None,
                task,
                {"statusId": str(rule.status_id), "version": task.version},
                system=ctx.actor,
                audit_data={"rule": trigger, "ref": ref},
            )
        moved += 1
    return moved
