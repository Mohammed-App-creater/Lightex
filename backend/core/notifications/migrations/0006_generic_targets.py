"""Platform Stage 2: generic notifications (docs/platform/stage2-contract.md §3, §4).

- `DomainEvent` now belongs to the `events` app (state only; `Notification.event` follows it).
- Notifications gain `target_type`, `target_id`, `title` and `link`, filled from the task (`tracking.task`) or the
  project (`tracking.project`) of existing rows; `project` becomes nullable (core targets without a project).
- Preference keys `tracking.comment.created|mentioned` become `core.comment.created|mentioned` (values unchanged).
"""

import django.db.models.deletion
from django.db import migrations, models

PREFERENCE_KEYS = {
    "tracking.comment.created": "core.comment.created",
    "tracking.comment.mentioned": "core.comment.mentioned",
}

FORWARD_SQL = """
SET CONSTRAINTS ALL IMMEDIATE;
UPDATE notifications_notification n
   SET target_type = 'tracking.task', target_id = n.task_id,
       title = LEFT(t.title, 300)
  FROM tasks_task t
 WHERE n.task_id = t.id AND n.target_id IS NULL;
UPDATE notifications_notification n
   SET target_type = 'tracking.project', target_id = n.project_id,
       title = LEFT(p.name, 300)
  FROM projects_project p
 WHERE n.project_id = p.id AND n.target_id IS NULL;
"""


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
    _rename_keys(apps, PREFERENCE_KEYS)


def backwards(apps, schema_editor):
    _rename_keys(apps, {new: old for old, new in PREFERENCE_KEYS.items()})


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0005_namespace_event_types"),
        ("events", "0001_initial"),
        ("projects", "0001_initial"),
        ("tasks", "0001_initial"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AlterField(
                    model_name="notification",
                    name="event",
                    field=models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="notifications",
                        to="events.domainevent",
                    ),
                ),
                migrations.DeleteModel(name="DomainEvent"),
            ],
            database_operations=[],
        ),
        migrations.AddField(
            model_name="notification",
            name="target_type",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
        migrations.AddField(
            model_name="notification",
            name="target_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="notification",
            name="title",
            field=models.CharField(blank=True, default="", max_length=300),
        ),
        migrations.AddField(
            model_name="notification",
            name="link",
            field=models.CharField(blank=True, default="", max_length=500),
        ),
        migrations.AlterField(
            model_name="notification",
            name="project",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="+",
                to="projects.project",
            ),
        ),
        migrations.AlterField(model_name="notification", name="type", field=models.CharField(max_length=16)),
        migrations.RunSQL(FORWARD_SQL, migrations.RunSQL.noop),
        migrations.RunPython(forwards, backwards),
    ]
