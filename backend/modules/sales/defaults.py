"""Per-workspace defaults: settings, the five default pipeline stages and the working calendar.

Seeded lazily and idempotently on first read (`ensure_defaults`, called by the selectors that read settings, stages
and the calendar), not from the module's enable path: core has no per-module enable hook, and a lazy get-or-create
also covers workspaces where sales was enabled before S1 shipped. The settings row is the marker: whoever creates
it seeds the stages, in the same transaction, so concurrent first reads seed once.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction

from .models import PipelineStage, SalesCalendar, SalesSettings

#: (name, category, default probability), in board order (spec §4).
DEFAULT_STAGES = (
    ("Opportunity", PipelineStage.OPEN, 20),
    ("Quotation", PipelineStage.OPEN, 40),
    ("Negotiation", PipelineStage.OPEN, 70),
    ("Won", PipelineStage.WON, 100),
    ("Lost", PipelineStage.LOST, 0),
)


def ensure_defaults(workspace: Any) -> SalesSettings:
    wid = getattr(workspace, "pk", workspace)
    found = SalesSettings.objects.for_workspace(wid).first()
    if found is not None:
        return found
    with transaction.atomic():
        settings, created = SalesSettings.objects.for_workspace(wid).get_or_create(workspace_id=wid)
        if created:
            PipelineStage.objects.bulk_create(
                PipelineStage(
                    workspace_id=wid,
                    name=name,
                    order=i,
                    category=category,
                    default_probability=probability,
                    is_system=category != PipelineStage.OPEN,
                )
                for i, (name, category, probability) in enumerate(DEFAULT_STAGES)
            )
            SalesCalendar.objects.for_workspace(wid).get_or_create(workspace_id=wid)
    return settings
