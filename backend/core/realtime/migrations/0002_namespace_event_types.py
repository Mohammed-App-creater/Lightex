"""Platform Stage 1: realtime event types get their module prefix (docs/platform/stage1-contract.md §3).

Renames the stored replay rows (the column and the envelope's `type`). Control events (hello, reset, reconnect) are
never stored and keep their names. Idempotent; the reverse strips the prefix.
"""

from django.db import migrations

TYPES = {
    "access.changed": "core.access.changed",
    "inbox.changed": "core.inbox.changed",
    "presence.updated": "core.presence.updated",
    "attachment.changed": "tracking.attachment.changed",
    "comment.changed": "tracking.comment.changed",
    "dashboard.changed": "tracking.dashboard.changed",
    "import.progress": "tracking.import.progress",
    "integration.changed": "tracking.integration.changed",
    "project.changed": "tracking.project.changed",
    "task.changed": "tracking.task.changed",
    "tasks.bulk_changed": "tracking.tasks.bulk_changed",
}


def _rename(apps, mapping):
    RealtimeEvent = apps.get_model("realtime", "RealtimeEvent")
    for row in RealtimeEvent.objects.filter(type__in=list(mapping)).iterator():
        row.type = mapping[row.type]
        if isinstance(row.payload, dict):
            row.payload = {**row.payload, "type": row.type}
        row.save(update_fields=["type", "payload"])


def namespace_types(apps, schema_editor):
    _rename(apps, TYPES)


def strip_types(apps, schema_editor):
    _rename(apps, {new: old for old, new in TYPES.items()})


class Migration(migrations.Migration):
    dependencies = [("realtime", "0001_initial")]

    operations = [migrations.RunPython(namespace_types, strip_types)]
