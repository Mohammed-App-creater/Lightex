"""Platform Stage 1: namespaced event types (docs/platform/stage1-contract.md §3).

Widens `DomainEvent.type` (32 is too short for `tracking.project.access_requested`), renames stored outbox rows, and
renames the keys of every `NotificationPreference.events` row (values unchanged; unknown keys kept). Idempotent; the
reverse renames back.
"""

from django.db import migrations, models

EVENT_TYPES = {
    "task_assigned": "tracking.task.assigned",
    "status_change": "tracking.task.status_changed",
    "mentioned": "tracking.comment.mentioned",
    "comment": "tracking.comment.created",
    "sprint_started": "tracking.sprint.started",
    "sprint_completed": "tracking.sprint.completed",
    "access_request": "tracking.project.access_requested",
    "workspace_access_request": "core.workspace.access_requested",
    "due_soon": "tracking.task.due_soon",
    "import_finished": "tracking.import.finished",
    "invitation": "core.member.invited",
}
PREFERENCE_KEYS = {
    "assigned": "tracking.task.assigned",
    "mentioned": "tracking.comment.mentioned",
    "status_change": "tracking.task.status_changed",
    "comment": "tracking.comment.created",
    "due_soon": "tracking.task.due_soon",
    "sprint_started": "tracking.sprint.started",
}


def _rename_types(apps, mapping):
    DomainEvent = apps.get_model("notifications", "DomainEvent")
    for old, new in mapping.items():
        DomainEvent.objects.filter(type=old).update(type=new)


def _rename_keys(apps, mapping):
    NotificationPreference = apps.get_model("notifications", "NotificationPreference")
    for prefs in NotificationPreference.objects.all().iterator():
        events = prefs.events if isinstance(prefs.events, dict) else {}
        renamed = {mapping.get(key, key): value for key, value in events.items() if key not in mapping.values()}
        renamed.update({key: value for key, value in events.items() if key in mapping.values()})
        if renamed != events:
            prefs.events = renamed
            prefs.save(update_fields=["events"])


def forwards(apps, schema_editor):
    _rename_types(apps, EVENT_TYPES)
    _rename_keys(apps, PREFERENCE_KEYS)


def backwards(apps, schema_editor):
    _rename_types(apps, {new: old for old, new in EVENT_TYPES.items()})
    _rename_keys(apps, {new: old for old, new in PREFERENCE_KEYS.items()})


class Migration(migrations.Migration):
    dependencies = [("notifications", "0004_board38_channel_preferences")]

    operations = [
        migrations.AlterField(model_name="domainevent", name="type", field=models.CharField(max_length=64)),
        migrations.RunPython(forwards, backwards),
    ]
