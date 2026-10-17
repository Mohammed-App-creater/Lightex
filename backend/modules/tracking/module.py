"""The tracking module's definition: permissions, default role grants, event types, templates and navigation.

Registered from `modules.tracking.hooks.register()` (the projects AppConfig `ready()`). Not toggleable in this phase.
"""

from __future__ import annotations

from typing import Any

from core.access.catalogue import project_permission, workspace_permission
from core.modules.registry import EventTypeDef, ModuleDefinition, NavItem

KEY = "tracking"

# A project always keeps at least one holder (never a role name).
PROJECT_ADMIN_PERMISSION = "tracking.project.manage_members"

_ws = workspace_permission
_prj = project_permission

PERMISSIONS = (
    # Workspace scope
    _ws("tracking.project.create", "Planning", "Create projects", "Start new projects in this workspace"),
    _ws(
        "tracking.project.assign_admin", "Administration", "Assign project admins", "Make members admins of any project"
    ),
    _ws(
        "tracking.integration.manage",
        "Administration",
        "Manage integrations",
        "Connect GitHub and GitLab, choose repositories and disconnect",
    ),
    # Project scope, in my_permissions order
    _prj("tracking.project.view", "Administration", "View project", "See the project, its board and tasks"),
    _prj("tracking.project.update", "Administration", "Project settings", "Rename, change key and description"),
    _prj("tracking.project.archive", "Administration", "Archive project", "Close out finished projects"),
    _prj("tracking.project.delete", "Administration", "Delete project", "Delete the project and its tasks"),
    _prj("tracking.project.manage_members", "Collaboration", "Manage members", "Add people and set their project role"),
    _prj("tracking.objective.manage", "Planning", "Set objectives", "Create objectives and link tasks"),
    _prj("tracking.milestone.manage", "Planning", "Edit milestones", "Create milestones and move dates"),
    _prj("tracking.epic.manage", "Planning", "Manage epics", "Create and rename epics"),
    _prj("tracking.sprint.manage", "Planning", "Manage sprints", "Start, close and plan sprints"),
    _prj("tracking.status.manage", "Planning", "Edit workflow", "Add, rename and reorder statuses"),
    _prj("tracking.field.manage", "Planning", "Manage custom fields", "Create, edit, reorder and delete custom fields"),
    _prj("tracking.task.create", "Tasks", "Create tasks", "Add tasks to the board and backlog"),
    _prj("tracking.task.edit_any", "Tasks", "Edit any task", "Change fields on others’ tasks"),
    _prj("tracking.task.edit_own", "Tasks", "Edit own tasks", "Change tasks you reported or are assigned"),
    _prj("tracking.task.delete", "Tasks", "Delete tasks", "Remove tasks (restorable for 30 days)"),
    _prj("tracking.task.assign", "Tasks", "Assign tasks", "Change who a task is assigned to"),
    _prj("tracking.task.move", "Tasks", "Move tasks", "Drag tasks between columns and sprints"),
    _prj("tracking.project.import", "Tasks", "Import tasks", "Bring in tasks from a CSV or another tool’s export"),
    _prj(
        "tracking.development.link",
        "Tasks",
        "Link code",
        "Create branches and link or unlink pull requests, commits and branches",
    ),
    _prj("tracking.time.log", "Tasks", "Log time", "Track time on tasks with the timer or by hand"),
    _prj("tracking.time.delete_any", "Tasks", "Delete anyone’s time", "Remove time entries logged by others"),
    _prj("tracking.comment.create", "Collaboration", "Comment", "Reply and mention teammates"),
    _prj("tracking.comment.edit_own", "Collaboration", "Edit own comments", "Fix typos in your comments"),
    _prj("tracking.comment.delete_any", "Collaboration", "Delete any comment", "Remove anyone’s comment"),
    _prj("tracking.attachment.upload", "Collaboration", "Upload files", "Attach images and code files"),
    _prj("tracking.attachment.delete_any", "Collaboration", "Delete any file", "Remove anyone’s attachment"),
    _prj("tracking.dashboard.create", "Reports", "Create dashboards", "Build dashboards and edit the ones you created"),
    _prj(
        "tracking.dashboard.manage",
        "Reports",
        "Manage shared dashboards",
        "Edit, rearrange and delete any shared dashboard",
    ),
    _prj("tracking.report.view", "Reports", "View reports", "Velocity, burndown, cycle time"),
)

WORKSPACE_CODES = [p.code for p in PERMISSIONS if p.scope == "workspace"]
PROJECT_CODES = [p.code for p in PERMISSIONS if p.scope == "project"]

DEFAULT_ROLE_GRANTS: dict[str, list[str]] = {
    "owner": list(WORKSPACE_CODES),
    "admin": list(WORKSPACE_CODES),
    "project_admin": list(PROJECT_CODES),
    "manager": [
        c
        for c in PROJECT_CODES
        if c not in ("tracking.project.archive", "tracking.project.delete", PROJECT_ADMIN_PERMISSION)
    ],
    "project_member": [
        "tracking.project.view",
        "tracking.task.create",
        "tracking.task.edit_own",
        "tracking.task.assign",
        "tracking.task.move",
        "tracking.project.import",
        "tracking.development.link",
        "tracking.time.log",
        "tracking.comment.create",
        "tracking.comment.edit_own",
        "tracking.attachment.upload",
        "tracking.dashboard.create",
        "tracking.report.view",
    ],
    "viewer": ["tracking.project.view"],
}
LOCKED_ROLE_GRANTS: dict[str, list[str]] = {
    "owner": list(WORKSPACE_CODES),
    "project_admin": list(PROJECT_CODES),
    "manager": ["tracking.project.view"],
    "project_member": ["tracking.project.view"],
    "viewer": ["tracking.project.view"],
}


def _key(ctx: dict[str, Any]) -> str:
    return str(ctx.get("task_key") or "")


_ALL_ON = {"in_app": True, "email": True, "telegram": True, "sms": False, "push": True}
_IN_APP = {"in_app": True, "email": False, "telegram": False, "sms": False, "push": False}

EVENT_TYPES = (
    EventTypeDef(
        "tracking.task.assigned",
        "Assigned to me",
        _ALL_ON,
        channel_template="assigned",
        email_templates=("task_assigned",),
        channel_summary=lambda ctx: f"{_key(ctx)} assigned to you",
        position=0,
    ),
    EventTypeDef(
        "tracking.task.status_changed",
        "Status change on my tasks",
        _IN_APP,
        channel_template="status_change",
        channel_summary=lambda ctx: f"{_key(ctx)} moved to {ctx.get('to_status', '')}",
        position=20,
    ),
    EventTypeDef(
        "tracking.task.due_soon",
        "Due soon",
        {"in_app": True, "email": True, "telegram": True, "sms": True, "push": True},
        channel_template="due_soon",
        email_templates=("due_soon",),
        channel_summary=lambda ctx: f"{_key(ctx)} is due {ctx.get('due_relative', 'soon')}",
        position=40,
    ),
    EventTypeDef(
        "tracking.sprint.started",
        "Sprint started",
        _IN_APP,
        channel_template="sprint_started",
        email_templates=("sprint_started",),
        channel_summary=lambda ctx: f"{ctx.get('sprint_name', 'Sprint')} started",
        channel_button="Open board",
        position=50,
    ),
    EventTypeDef(
        "tracking.sprint.completed", "Sprint completed", email_templates=("sprint_completed",), preference=False
    ),
    EventTypeDef("tracking.project.access_requested", "Access requests", preference=False),
    EventTypeDef("tracking.import.finished", "Imports", preference=False),
)

DEFINITION = ModuleDefinition(
    key=KEY,
    name="Tracking",
    description="Projects, boards, sprints, tasks, time tracking, reports and dashboards.",
    is_core=False,
    depends_on=(),
    permissions=PERMISSIONS,
    default_role_grants=DEFAULT_ROLE_GRANTS,
    locked_role_grants=LOCKED_ROLE_GRANTS,
    event_types=EVENT_TYPES,
    target_types=("tracking.task", "tracking.project", "tracking.sprint"),
    search_provider=KEY,
    nav_items=(
        NavItem("projects", "Projects", "folder", "", "core.workspace.view"),
        NavItem("my-tasks", "My tasks", "check-square", "my-tasks", "core.workspace.view"),
        NavItem("timesheet", "Timesheet", "clock", "timesheet", "core.workspace.view"),
    ),
    toggleable=False,
)
