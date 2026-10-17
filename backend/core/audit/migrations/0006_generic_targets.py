"""Platform Stage 2: generic audit targets (docs/platform/stage2-contract.md §4).

- `entity_type` becomes `target_type` with namespaced values (`task` → `tracking.task`), `entity_id` becomes
  `target_id`, and `module` is added (the action's namespace).
- Comments and attachments are core services now: `tracking.comment.*` / `tracking.attachment.*` actions become
  `core.comment.*` / `core.attachment.*`.

Existing rows are preserved; the reverse strips the namespace again.
"""

from django.db import migrations, models

FORWARD_SQL = """
UPDATE audit_auditlog SET action = 'core.' || substr(action, 10)
 WHERE action LIKE 'tracking.comment.%' OR action LIKE 'tracking.attachment.%';
UPDATE audit_auditlog
   SET module = split_part(action, '.', 1),
       target_type = split_part(action, '.', 1) || '.' || split_part(action, '.', 2)
 WHERE action LIKE '%.%.%';
"""

BACKWARD_SQL = """
UPDATE audit_auditlog SET target_type = split_part(target_type, '.', 2) WHERE target_type LIKE '%.%';
UPDATE audit_auditlog SET action = 'tracking.' || substr(action, 6)
 WHERE action LIKE 'core.comment.%' OR action LIKE 'core.attachment.%';
"""


class Migration(migrations.Migration):
    dependencies = [("audit", "0005_namespace_actions")]

    operations = [
        migrations.RenameField(model_name="auditlog", old_name="entity_type", new_name="target_type"),
        migrations.RenameField(model_name="auditlog", old_name="entity_id", new_name="target_id"),
        migrations.AlterField(model_name="auditlog", name="target_type", field=models.CharField(max_length=64)),
        migrations.AddField(
            model_name="auditlog",
            name="module",
            field=models.CharField(blank=True, default="", max_length=32),
        ),
        migrations.RunSQL(FORWARD_SQL, BACKWARD_SQL),
    ]
