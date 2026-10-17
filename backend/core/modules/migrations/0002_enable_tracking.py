"""Platform Stage 3: every existing workspace gets tracking enabled (new workspaces get it at creation)."""

from django.db import migrations
from django.utils import timezone


def enable_tracking(apps, schema_editor):
    Workspace = apps.get_model("workspaces", "Workspace")
    WorkspaceModule = apps.get_model("platform_modules", "WorkspaceModule")
    have = set(WorkspaceModule.objects.filter(module_key="tracking").values_list("workspace_id", flat=True))
    now = timezone.now()
    WorkspaceModule.objects.bulk_create(
        [
            WorkspaceModule(workspace_id=wid, module_key="tracking", enabled=True, enabled_at=now)
            for wid in Workspace._base_manager.values_list("pk", flat=True)
            if wid not in have
        ]
    )


class Migration(migrations.Migration):
    dependencies = [
        ("platform_modules", "0001_initial"),
        ("workspaces", "0002_workspace_sms_enabled"),
    ]

    operations = [migrations.RunPython(enable_tracking, migrations.RunPython.noop)]
