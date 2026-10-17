"""Platform Stage 1: audit actions get their module prefix (docs/platform/stage1-contract.md §3).

`task.created` becomes `tracking.task.created`, `member.invited` becomes `core.member.invited`. `entity_type` is
unchanged. Rows already namespaced are left alone, so it is idempotent; the reverse strips the prefix.
"""

from django.db import migrations

ACTIONS = {
    "access.changed": "core.access.changed",
    "inbox.changed": "core.inbox.changed",
    "presence.updated": "core.presence.updated",
    "member.invite_resent": "core.member.invite_resent",
    "member.invite_revoked": "core.member.invite_revoked",
    "member.invited": "core.member.invited",
    "member.joined": "core.member.joined",
    "member.removed": "core.member.removed",
    "member.role_changed": "core.member.role_changed",
    "member.updated": "core.member.updated",
    "role.created": "core.role.created",
    "role.deleted": "core.role.deleted",
    "role.updated": "core.role.updated",
    "workspace.created": "core.workspace.created",
    "workspace.deleted": "core.workspace.deleted",
    "workspace.updated": "core.workspace.updated",
    "attachment.changed": "tracking.attachment.changed",
    "attachment.created": "tracking.attachment.created",
    "attachment.deleted": "tracking.attachment.deleted",
    "comment.changed": "tracking.comment.changed",
    "comment.created": "tracking.comment.created",
    "comment.deleted": "tracking.comment.deleted",
    "comment.purged": "tracking.comment.purged",
    "comment.restored": "tracking.comment.restored",
    "comment.updated": "tracking.comment.updated",
    "dashboard.changed": "tracking.dashboard.changed",
    "dashboard.created": "tracking.dashboard.created",
    "dashboard.deleted": "tracking.dashboard.deleted",
    "dashboard.layout_updated": "tracking.dashboard.layout_updated",
    "dashboard.updated": "tracking.dashboard.updated",
    "epic.created": "tracking.epic.created",
    "epic.deleted": "tracking.epic.deleted",
    "epic.updated": "tracking.epic.updated",
    "import.progress": "tracking.import.progress",
    "integration.backfilled": "tracking.integration.backfilled",
    "integration.changed": "tracking.integration.changed",
    "integration.connected": "tracking.integration.connected",
    "integration.disconnected": "tracking.integration.disconnected",
    "integration.error": "tracking.integration.error",
    "integration.reconnected": "tracking.integration.reconnected",
    "integration.recovered": "tracking.integration.recovered",
    "integration.repositories_updated": "tracking.integration.repositories_updated",
    "integration.repository_scoped": "tracking.integration.repository_scoped",
    "integration.sync_requested": "tracking.integration.sync_requested",
    "label.created": "tracking.label.created",
    "label.deleted": "tracking.label.deleted",
    "label.updated": "tracking.label.updated",
    "milestone.created": "tracking.milestone.created",
    "milestone.deleted": "tracking.milestone.deleted",
    "milestone.updated": "tracking.milestone.updated",
    "objective.created": "tracking.objective.created",
    "objective.deleted": "tracking.objective.deleted",
    "objective.task_unlinked": "tracking.objective.task_unlinked",
    "objective.updated": "tracking.objective.updated",
    "project.access_denied": "tracking.project.access_denied",
    "project.access_requested": "tracking.project.access_requested",
    "project.archived": "tracking.project.archived",
    "project.changed": "tracking.project.changed",
    "project.created": "tracking.project.created",
    "project.custom_field_created": "tracking.project.custom_field_created",
    "project.custom_field_deleted": "tracking.project.custom_field_deleted",
    "project.custom_field_updated": "tracking.project.custom_field_updated",
    "project.custom_fields_reordered": "tracking.project.custom_fields_reordered",
    "project.deleted": "tracking.project.deleted",
    "project.dev_automation_updated": "tracking.project.dev_automation_updated",
    "project.import_completed": "tracking.project.import_completed",
    "project.import_started": "tracking.project.import_started",
    "project.purged": "tracking.project.purged",
    "project.restored": "tracking.project.restored",
    "project.unarchived": "tracking.project.unarchived",
    "project.updated": "tracking.project.updated",
    "project_member.added": "tracking.project_member.added",
    "project_member.removed": "tracking.project_member.removed",
    "sprint.completed": "tracking.sprint.completed",
    "sprint.created": "tracking.sprint.created",
    "sprint.deleted": "tracking.sprint.deleted",
    "sprint.started": "tracking.sprint.started",
    "sprint.updated": "tracking.sprint.updated",
    "status.created": "tracking.status.created",
    "status.deleted": "tracking.status.deleted",
    "status.reordered": "tracking.status.reordered",
    "status.updated": "tracking.status.updated",
    "task.assigned": "tracking.task.assigned",
    "task.changed": "tracking.task.changed",
    "task.created": "tracking.task.created",
    "task.deleted": "tracking.task.deleted",
    "task.dependency_added": "tracking.task.dependency_added",
    "task.dependency_removed": "tracking.task.dependency_removed",
    "task.dev_branch_created": "tracking.task.dev_branch_created",
    "task.dev_linked": "tracking.task.dev_linked",
    "task.dev_pr_state": "tracking.task.dev_pr_state",
    "task.dev_unlinked": "tracking.task.dev_unlinked",
    "task.imported": "tracking.task.imported",
    "task.objective_linked": "tracking.task.objective_linked",
    "task.purged": "tracking.task.purged",
    "task.restored": "tracking.task.restored",
    "task.status_changed": "tracking.task.status_changed",
    "task.time_entry_deleted": "tracking.task.time_entry_deleted",
    "task.time_logged": "tracking.task.time_logged",
    "task.updated": "tracking.task.updated",
    "tasks.bulk_changed": "tracking.tasks.bulk_changed",
    "view.created": "tracking.view.created",
    "view.deleted": "tracking.view.deleted",
    "view.updated": "tracking.view.updated",
}


def namespace_actions(apps, schema_editor):
    AuditLog = apps.get_model("audit", "AuditLog")
    for old, new in ACTIONS.items():
        AuditLog.objects.filter(action=old).update(action=new)


def strip_actions(apps, schema_editor):
    AuditLog = apps.get_model("audit", "AuditLog")
    for old, new in ACTIONS.items():
        AuditLog.objects.filter(action=new).update(action=old)


class Migration(migrations.Migration):
    dependencies = [("audit", "0004_board37_actor_kind")]

    operations = [migrations.RunPython(namespace_actions, strip_actions)]
