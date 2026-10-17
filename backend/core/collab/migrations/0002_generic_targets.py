"""Platform Stage 2: comments and attachments refer to any registered target (docs/platform/stage2-contract.md §2).

Adds `workspace`, `target_type` and `target_id`, fills them from each row's task (`tracking.task`, the task's id and
its project's workspace), then drops the task foreign key. Existing rows are preserved; the reverse restores the
task column from `target_id`.
"""

import django.db.models.deletion
from django.db import migrations, models

FORWARD_SQL = """
SET CONSTRAINTS ALL IMMEDIATE;
UPDATE collaboration_{table} c
   SET workspace_id = p.workspace_id, target_type = 'tracking.task', target_id = c.task_id
  FROM tasks_task t JOIN projects_project p ON p.id = t.project_id
 WHERE c.task_id = t.id;
"""

BACKWARD_SQL = """
SET CONSTRAINTS ALL IMMEDIATE;
UPDATE collaboration_{table} SET task_id = target_id WHERE target_type = 'tracking.task';
DELETE FROM collaboration_{table} WHERE task_id IS NULL;
"""


def _target_fields(model_name):
    return [
        migrations.AddField(
            model_name=model_name,
            name="workspace",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="+",
                to="workspaces.workspace",
            ),
        ),
        migrations.AddField(
            model_name=model_name, name="target_type", field=models.CharField(default="", max_length=64)
        ),
        migrations.AddField(model_name=model_name, name="target_id", field=models.UUIDField(null=True)),
        migrations.AlterField(
            model_name=model_name,
            name="task",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="+",
                to="tasks.task",
            ),
        ),
        migrations.RunSQL(FORWARD_SQL.format(table=model_name), BACKWARD_SQL.format(table=model_name)),
        migrations.RemoveField(model_name=model_name, name="task"),
        migrations.AlterField(
            model_name=model_name,
            name="workspace",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE, related_name="+", to="workspaces.workspace"
            ),
        ),
        migrations.AlterField(model_name=model_name, name="target_type", field=models.CharField(max_length=64)),
        migrations.AlterField(model_name=model_name, name="target_id", field=models.UUIDField()),
    ]


class Migration(migrations.Migration):
    dependencies = [
        ("collaboration", "0001_initial"),
        ("projects", "0001_initial"),
        ("tasks", "0001_initial"),
        ("workspaces", "0001_initial"),
    ]

    operations = [
        migrations.RemoveIndex(model_name="comment", name="comment_task_created"),
        migrations.RemoveIndex(model_name="attachment", name="attachment_task_status"),
        *_target_fields("comment"),
        *_target_fields("attachment"),
        migrations.AddIndex(
            model_name="comment",
            index=models.Index(fields=["target_type", "target_id", "created_at"], name="comment_target_created"),
        ),
        migrations.AddIndex(
            model_name="attachment",
            index=models.Index(fields=["target_type", "target_id", "status"], name="attachment_target_status"),
        ),
    ]
