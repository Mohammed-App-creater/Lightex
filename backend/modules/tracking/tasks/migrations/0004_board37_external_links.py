"""Board 37: tasks.ExternalLink becomes the store for linked branches, commits and PRs/MRs (§3.3)."""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("integrations", "0001_initial"),
        ("tasks", "0003_task_start_date"),
        ("workspaces", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="externallink",
            name="ahead_by",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="externallink",
            name="approvals",
            field=models.PositiveSmallIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="externallink",
            name="author_login",
            field=models.CharField(blank=True, default="", max_length=100),
        ),
        migrations.AddField(
            model_name="externallink",
            name="author_name",
            field=models.CharField(blank=True, default="", max_length=100),
        ),
        migrations.AddField(
            model_name="externallink",
            name="author_user",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="externallink",
            name="base_branch",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="externallink",
            name="base_url",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="externallink",
            name="checks",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="externallink",
            name="checks_state",
            field=models.CharField(blank=True, default="", max_length=8),
        ),
        migrations.AddField(
            model_name="externallink",
            name="closed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="externallink",
            name="head_branch",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="externallink",
            name="link_source",
            field=models.CharField(
                choices=[
                    ("auto", "Auto"),
                    ("manual", "Manual"),
                    ("created", "Created"),
                ],
                default="auto",
                max_length=8,
            ),
        ),
        migrations.AddField(
            model_name="externallink",
            name="linked_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="externallink",
            name="merged_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="externallink",
            name="number",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="externallink",
            name="repo_external_id",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
        migrations.AddField(
            model_name="externallink",
            name="repo_full_path",
            field=models.CharField(blank=True, default="", max_length=300),
        ),
        migrations.AddField(
            model_name="externallink",
            name="repository",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="links",
                to="integrations.repository",
            ),
        ),
        migrations.AddField(
            model_name="externallink",
            name="sha",
            field=models.CharField(blank=True, default="", max_length=40),
        ),
        migrations.AddField(
            model_name="externallink",
            name="source_created_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="externallink",
            name="source_updated_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="externallink",
            name="state",
            field=models.CharField(blank=True, default="", max_length=10),
        ),
        migrations.AddField(
            model_name="externallink",
            name="suppressed",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="externallink",
            name="title",
            field=models.CharField(blank=True, default="", max_length=300),
        ),
        migrations.AddField(
            model_name="externallink",
            name="workspace",
            # The table has no rows in any environment (v1 had no endpoints), so a NOT NULL column needs no default.
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="+",
                to="workspaces.workspace",
            ),
        ),
        migrations.AlterField(
            model_name="externallink",
            name="external_id",
            field=models.CharField(max_length=200),
        ),
        migrations.AddIndex(
            model_name="externallink",
            index=models.Index(
                fields=[
                    "workspace",
                    "provider",
                    "repo_external_id",
                    "type",
                    "external_id",
                ],
                name="external_link_object",
            ),
        ),
        migrations.AddIndex(
            model_name="externallink",
            index=models.Index(
                fields=["workspace", "provider", "repo_external_id", "sha"],
                name="external_link_sha",
            ),
        ),
        migrations.AddIndex(
            model_name="externallink",
            index=models.Index(
                fields=["task", "type", "suppressed"], name="external_link_task"
            ),
        ),
        migrations.AddConstraint(
            model_name="externallink",
            constraint=models.UniqueConstraint(
                fields=("task", "provider", "type", "external_id"),
                name="external_link_unique",
            ),
        ),
    ]
