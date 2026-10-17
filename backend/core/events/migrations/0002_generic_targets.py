"""Platform Stage 2: generic domain events (docs/platform/stage2-contract.md §3).

- Adds `target_type` / `target_id` and fills them from the payload (`taskId` → `tracking.task`, `sprintId` →
  `tracking.sprint`, otherwise the project → `tracking.project`).
- Moves the `project` foreign key into `payload.projectId`, then drops the column (core no longer references a module
  table here).
- Renames comment event types to the core namespace (`tracking.comment.*` → `core.comment.*`).
- Renames the table to `events_domainevent`.

Existing rows are preserved; the reverse restores the project column from the payload.
"""

from django.db import migrations, models

COMMENT_TYPES = {
    "tracking.comment.created": "core.comment.created",
    "tracking.comment.mentioned": "core.comment.mentioned",
}

FORWARD_SQL = """
SET CONSTRAINTS ALL IMMEDIATE;
UPDATE notifications_domainevent
   SET payload = payload || jsonb_build_object('projectId', project_id::text)
 WHERE project_id IS NOT NULL AND NOT (payload ? 'projectId');
UPDATE notifications_domainevent
   SET target_type = 'tracking.task', target_id = (payload->>'taskId')::uuid
 WHERE target_id IS NULL AND payload->>'taskId' ~* '^[0-9a-f-]{36}$';
UPDATE notifications_domainevent
   SET target_type = 'tracking.sprint', target_id = (payload->>'sprintId')::uuid
 WHERE target_id IS NULL AND payload->>'sprintId' ~* '^[0-9a-f-]{36}$';
UPDATE notifications_domainevent
   SET target_type = 'tracking.project', target_id = project_id
 WHERE target_id IS NULL AND project_id IS NOT NULL;
"""

BACKWARD_SQL = """
SET CONSTRAINTS ALL IMMEDIATE;
UPDATE notifications_domainevent e
   SET project_id = (e.payload->>'projectId')::uuid
 WHERE e.payload->>'projectId' ~* '^[0-9a-f-]{36}$'
   AND EXISTS (SELECT 1 FROM projects_project p WHERE p.id = (e.payload->>'projectId')::uuid);
"""


def rename_types(apps, mapping):
    DomainEvent = apps.get_model("events", "DomainEvent")
    for old, new in mapping.items():
        DomainEvent.objects.filter(type=old).update(type=new)


def forwards(apps, schema_editor):
    rename_types(apps, COMMENT_TYPES)


def backwards(apps, schema_editor):
    rename_types(apps, {new: old for old, new in COMMENT_TYPES.items()})


class Migration(migrations.Migration):
    dependencies = [("events", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="domainevent",
            name="target_type",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
        migrations.AddField(
            model_name="domainevent",
            name="target_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.RunSQL(FORWARD_SQL, BACKWARD_SQL),
        migrations.RunPython(forwards, backwards),
        migrations.RemoveField(model_name="domainevent", name="project"),
        migrations.AddIndex(
            model_name="domainevent",
            index=models.Index(fields=["target_type", "target_id"], name="event_target"),
        ),
        migrations.AlterModelTable(name="domainevent", table=None),
    ]
