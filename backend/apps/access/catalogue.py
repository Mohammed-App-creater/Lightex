"""The permission catalogue and default roles. Defined in code, synced to the DB on migrate.

Keys, labels and groups match the web client's src/lib/permissions/catalogue.ts.
"""

from __future__ import annotations

from dataclasses import dataclass, field

WORKSPACE = "workspace"
PROJECT = "project"


@dataclass(frozen=True)
class PermissionDef:
    code: str
    scope: str
    group: str
    label: str
    description: str


def _ws(code: str, group: str, label: str, description: str) -> PermissionDef:
    return PermissionDef(code, WORKSPACE, group, label, description)


def _prj(code: str, group: str, label: str, description: str) -> PermissionDef:
    return PermissionDef(code, PROJECT, group, label, description)


PERMISSIONS: list[PermissionDef] = [
    # Workspace scope
    _ws("project.create", "Planning", "Create projects", "Start new projects in this workspace"),
    _ws("workspace.manage_members", "Collaboration", "Manage members", "Invite, remove and change member roles"),
    _ws("audit.view", "Reports", "View audit log", "See who changed what across the workspace"),
    _ws("workspace.view", "Administration", "View workspace", "See the workspace and its project list"),
    _ws("workspace.update", "Administration", "Workspace settings", "Rename the workspace and change its URL"),
    _ws("workspace.manage_roles", "Administration", "Manage roles", "Create and edit roles"),
    _ws("project.assign_admin", "Administration", "Assign project admins", "Make members admins of any project"),
    _ws("workspace.delete", "Administration", "Delete workspace", "Delete the workspace and all its projects"),
    # Project scope
    _prj("task.create", "Tasks", "Create tasks", "Add tasks to the board and backlog"),
    _prj("task.edit_any", "Tasks", "Edit any task", "Change fields on others’ tasks"),
    _prj("task.edit_own", "Tasks", "Edit own tasks", "Change tasks you reported or are assigned"),
    _prj("task.assign", "Tasks", "Assign tasks", "Change who a task is assigned to"),
    _prj("task.move", "Tasks", "Move tasks", "Drag tasks between columns and sprints"),
    _prj("task.delete", "Tasks", "Delete tasks", "Remove tasks (restorable for 30 days)"),
    _prj("time.log", "Tasks", "Log time", "Track time on tasks with the timer or by hand"),
    _prj("time.delete_any", "Tasks", "Delete anyone’s time", "Remove time entries logged by others"),
    _prj("sprint.manage", "Planning", "Manage sprints", "Start, close and plan sprints"),
    _prj("milestone.manage", "Planning", "Edit milestones", "Create milestones and move dates"),
    _prj("objective.manage", "Planning", "Set objectives", "Create objectives and link tasks"),
    _prj("epic.manage", "Planning", "Manage epics", "Create and rename epics"),
    _prj("status.manage", "Planning", "Edit workflow", "Add, rename and reorder statuses"),
    _prj("field.manage", "Planning", "Manage custom fields", "Create, edit, reorder and delete custom fields"),
    _prj("comment.create", "Collaboration", "Comment", "Reply and mention teammates"),
    _prj("comment.edit_own", "Collaboration", "Edit own comments", "Fix typos in your comments"),
    _prj("comment.delete_any", "Collaboration", "Delete any comment", "Remove anyone’s comment"),
    _prj("attachment.upload", "Collaboration", "Upload files", "Attach images and code files"),
    _prj("attachment.delete_any", "Collaboration", "Delete any file", "Remove anyone’s attachment"),
    _prj("project.manage_members", "Collaboration", "Manage members", "Add people and set their project role"),
    _prj("report.view", "Reports", "View reports", "Velocity, burndown, cycle time"),
    _prj("project.view", "Administration", "View project", "See the project, its board and tasks"),
    _prj("project.update", "Administration", "Project settings", "Rename, change key and description"),
    _prj("project.archive", "Administration", "Archive project", "Close out finished projects"),
    _prj("project.delete", "Administration", "Delete project", "Delete the project and its tasks"),
]

BY_CODE: dict[str, PermissionDef] = {p.code: p for p in PERMISSIONS}
SCOPE_OF: dict[str, str] = {p.code: p.scope for p in PERMISSIONS}
WORKSPACE_CODES: list[str] = [p.code for p in PERMISSIONS if p.scope == WORKSPACE]
PROJECT_CODES: list[str] = [p.code for p in PERMISSIONS if p.scope == PROJECT]

# Order used in my_permissions arrays (stable, matches the client's constants).
WORKSPACE_ORDER = [
    "workspace.view",
    "workspace.update",
    "workspace.delete",
    "workspace.manage_members",
    "workspace.manage_roles",
    "project.create",
    "project.assign_admin",
    "audit.view",
]
PROJECT_ORDER = [
    "project.view",
    "project.update",
    "project.archive",
    "project.delete",
    "project.manage_members",
    "objective.manage",
    "milestone.manage",
    "epic.manage",
    "sprint.manage",
    "status.manage",
    "field.manage",
    "task.create",
    "task.edit_any",
    "task.edit_own",
    "task.delete",
    "task.assign",
    "task.move",
    "time.log",
    "time.delete_any",
    "comment.create",
    "comment.edit_own",
    "comment.delete_any",
    "attachment.upload",
    "attachment.delete_any",
    "report.view",
]
ORDER_INDEX = {c: i for i, c in enumerate(WORKSPACE_ORDER + PROJECT_ORDER)}


def ordered(codes) -> list[str]:
    return sorted(set(codes), key=lambda c: ORDER_INDEX.get(c, 999))


# Permissions that define "ownership"-type invariants (never role names):
OWNER_PERMISSION = "workspace.delete"  # the last holder can't be removed or demoted
PROJECT_ADMIN_PERMISSION = "project.manage_members"  # a project keeps at least one holder


@dataclass(frozen=True)
class RoleDef:
    key: str
    name: str
    scope: str
    description: str
    permissions: list[str]
    # Permissions a system role can never lose.
    core: list[str] = field(default_factory=list)


DEFAULT_ROLES: list[RoleDef] = [
    RoleDef(
        "owner",
        "Owner",
        WORKSPACE,
        "Full control, including deleting the workspace. Can’t be assigned.",
        list(WORKSPACE_ORDER),
        core=list(WORKSPACE_ORDER),
    ),
    RoleDef(
        "admin",
        "Admin",
        WORKSPACE,
        "Manages members, roles and projects.",
        [c for c in WORKSPACE_ORDER if c != "workspace.delete"],
        core=["workspace.view", "workspace.manage_members"],
    ),
    RoleDef(
        "member",
        "Member",
        WORKSPACE,
        "Sees the workspace and joins projects they’re added to.",
        ["workspace.view"],
        core=["workspace.view"],
    ),
    RoleDef(
        "project_admin",
        "Project Admin",
        PROJECT,
        "Everything in the project, including members and deletion.",
        list(PROJECT_ORDER),
        core=list(PROJECT_ORDER),
    ),
    RoleDef(
        "manager",
        "Manager",
        PROJECT,
        "Plans sprints and goals and edits any task.",
        [c for c in PROJECT_ORDER if c not in ("project.archive", "project.delete", "project.manage_members")],
        core=["project.view"],
    ),
    RoleDef(
        "project_member",
        "Member",
        PROJECT,
        "Creates tasks, works their own, comments and uploads.",
        [
            "project.view",
            "task.create",
            "task.edit_own",
            "task.assign",
            "task.move",
            "time.log",
            "comment.create",
            "comment.edit_own",
            "attachment.upload",
            "report.view",
        ],
        core=["project.view"],
    ),
    RoleDef(
        "viewer",
        "Viewer",
        PROJECT,
        "Read-only access to the board, backlog and goals.",
        ["project.view"],
        core=["project.view"],
    ),
]
ROLE_DEF_BY_KEY = {r.key: r for r in DEFAULT_ROLES}
