"""Platform Stage 2: `DomainEvent` moves from `notifications` to `events`.

State only: the table (`notifications_domainevent`) and its rows stay; 0002 reshapes and renames it.
"""

import uuid

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("notifications", "0005_namespace_event_types"),
        ("projects", "0001_initial"),
        ("workspaces", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.CreateModel(
                    name="DomainEvent",
                    fields=[
                        (
                            "id",
                            models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False),
                        ),
                        ("created_at", models.DateTimeField(default=django.utils.timezone.now, editable=False)),
                        ("updated_at", models.DateTimeField(auto_now=True)),
                        ("type", models.CharField(max_length=64)),
                        ("payload", models.JSONField(default=dict)),
                        ("processed_at", models.DateTimeField(blank=True, null=True)),
                        ("attempts", models.PositiveSmallIntegerField(default=0)),
                        ("error", models.TextField(blank=True, default="")),
                        (
                            "actor",
                            models.ForeignKey(
                                blank=True,
                                null=True,
                                on_delete=django.db.models.deletion.SET_NULL,
                                related_name="+",
                                to=settings.AUTH_USER_MODEL,
                            ),
                        ),
                        (
                            "project",
                            models.ForeignKey(
                                blank=True,
                                null=True,
                                on_delete=django.db.models.deletion.CASCADE,
                                related_name="+",
                                to="projects.project",
                            ),
                        ),
                        (
                            "workspace",
                            models.ForeignKey(
                                on_delete=django.db.models.deletion.CASCADE,
                                related_name="+",
                                to="workspaces.workspace",
                            ),
                        ),
                    ],
                    options={
                        "db_table": "notifications_domainevent",
                        "indexes": [models.Index(fields=["processed_at", "created_at"], name="event_unprocessed")],
                    },
                ),
            ],
            database_operations=[],
        ),
    ]
