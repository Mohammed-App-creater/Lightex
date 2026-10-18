"""Multiple assignees (TaskAssignee replaces Task.assignee) and task checklists. Existing assignees are copied
before the column is dropped."""

import core.common.models
import django.db.models.deletion
import django.utils.timezone
import uuid
from django.conf import settings
from django.db import migrations, models


def copy_assignees(apps, schema_editor):
    Task = apps.get_model("tasks", "Task")
    TaskAssignee = apps.get_model("tasks", "TaskAssignee")
    rows = Task._base_manager.filter(assignee__isnull=False).values_list("pk", "assignee_id", "workspace_id")
    TaskAssignee._base_manager.bulk_create(
        [TaskAssignee(task_id=t, user_id=u, workspace_id=w) for t, u, w in rows.iterator()], batch_size=1000
    )


def restore_assignees(apps, schema_editor):
    Task = apps.get_model("tasks", "Task")
    TaskAssignee = apps.get_model("tasks", "TaskAssignee")
    first: dict = {}
    for task_id, user_id in TaskAssignee._base_manager.order_by("task_id", "position", "created_at").values_list("task_id", "user_id"):
        first.setdefault(task_id, user_id)
    for task_id, user_id in first.items():
        Task._base_manager.filter(pk=task_id).update(assignee_id=user_id)


class Migration(migrations.Migration):
    dependencies = [
        ("tasks", "0001_initial"),
        ("workspaces", "0003_drop_single_role"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ChecklistItem",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(default=django.utils.timezone.now, editable=False),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("text", models.CharField(max_length=500)),
                ("done", models.BooleanField(default=False)),
                ("position", models.CharField(db_collation="C", max_length=64)),
                ("done_at", models.DateTimeField(blank=True, null=True)),
            ],
            bases=(core.common.models.WorkspaceScopedMixin, models.Model),
        ),
        migrations.CreateModel(
            name="TaskAssignee",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(default=django.utils.timezone.now, editable=False),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("position", models.PositiveSmallIntegerField(default=0)),
            ],
            bases=(core.common.models.WorkspaceScopedMixin, models.Model),
        ),
        migrations.AddField(
            model_name="checklistitem",
            name="created_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="checklistitem",
            name="done_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="checklistitem",
            name="task",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="checklist_items",
                to="tasks.task",
            ),
        ),
        migrations.AddField(
            model_name="checklistitem",
            name="workspace",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="+",
                to="workspaces.workspace",
            ),
        ),
        migrations.AddField(
            model_name="taskassignee",
            name="task",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="task_assignees",
                to="tasks.task",
            ),
        ),
        migrations.AddField(
            model_name="taskassignee",
            name="user",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="task_assignments",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="taskassignee",
            name="workspace",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="+",
                to="workspaces.workspace",
            ),
        ),
        migrations.AddField(
            model_name="task",
            name="assignees",
            field=models.ManyToManyField(
                blank=True,
                related_name="assigned_tasks",
                through="tasks.TaskAssignee",
                through_fields=("task", "user"),
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddIndex(
            model_name="checklistitem",
            index=models.Index(fields=["task", "position"], name="checklist_task_order"),
        ),
        migrations.AddIndex(
            model_name="taskassignee",
            index=models.Index(fields=["user", "task"], name="task_assignee_user"),
        ),
        migrations.AddConstraint(
            model_name="taskassignee",
            constraint=models.UniqueConstraint(fields=("task", "user"), name="task_assignee_unique"),
        ),
        migrations.RunPython(copy_assignees, restore_assignees),
        migrations.RemoveIndex(
            model_name="task",
            name="task_assignee",
        ),
        migrations.RemoveField(
            model_name="task",
            name="assignee",
        ),
    ]
