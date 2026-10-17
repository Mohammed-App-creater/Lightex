"""The permission catalogue and default roles. Defined in code, synced to the DB on migrate.

Keys, labels and groups match the web client's src/lib/permissions/catalogue.ts.
"""

from __future__ import annotations

from dataclasses import dataclass, field

WORKSPACE = "workspace"
PROJECT = "project"


CORE = "core"
TRACKING = "tracking"


def module_of(code: str) -> str:
    """The owning module is the code's first segment (`core.*` or `tracking.*`)."""
    return code.split(".", 1)[0]


@dataclass(frozen=True)
class PermissionDef:
    code: str
    scope: str
    group: str
    label: str
    description: str
    module: str


def _ws(code: str, group: str, label: str, description: str) -> PermissionDef:
    return PermissionDef(code, WORKSPACE, group, label, description, module_of(code))


def _prj(code: str, group: str, label: str, description: str) -> PermissionDef:
    return PermissionDef(code, PROJECT, group, label, description, module_of(code))


PERMISSIONS: list[PermissionDef] = [
    # Workspace scope
    _ws("tracking.project.create", "Planning", "Create projects", "Start new projects in this workspace"),
    _ws("core.workspace.manage_members", "Collaboration", "Manage members", "Invite, remove and change member roles"),
    _ws("core.audit.view", "Reports", "View audit log", "See who changed what across the workspace"),
    _ws("core.workspace.view", "Administration", "View workspace", "See the workspace and its project list"),
    _ws("core.workspace.update", "Administration", "Workspace settings", "Rename the workspace and change its URL"),
    _ws("core.roles.manage", "Administration", "Manage roles", "Create and edit roles"),
    _ws(
        "tracking.integration.manage",
        "Administration",
        "Manage integrations",
        "Connect GitHub and GitLab, choose repositories and disconnect",
    ),
    _ws(
        "tracking.project.assign_admin", "Administration", "Assign project admins", "Make members admins of any project"
    ),
    _ws("core.workspace.delete", "Administration", "Delete workspace", "Delete the workspace and all its projects"),
    # Platform Stage 1: catalogue and default roles only; their endpoints arrive in Stages 3 and 4.
    _ws("core.modules.manage", "Administration", "Manage modules", "Turn modules on and off for the workspace"),
    _ws("core.teams.manage", "Administration", "Manage teams", "Create teams and choose their members and leads"),
    # Project scope
    _prj("tracking.task.create", "Tasks", "Create tasks", "Add tasks to the board and backlog"),
    _prj("tracking.task.edit_any", "Tasks", "Edit any task", "Change fields on others’ tasks"),
    _prj("tracking.task.edit_own", "Tasks", "Edit own tasks", "Change tasks you reported or are assigned"),
    _prj("tracking.task.assign", "Tasks", "Assign tasks", "Change who a task is assigned to"),
    _prj("tracking.task.move", "Tasks", "Move tasks", "Drag tasks between columns and sprints"),
    _prj("tracking.task.delete", "Tasks", "Delete tasks", "Remove tasks (restorable for 30 days)"),
    _prj("tracking.time.log", "Tasks", "Log time", "Track time on tasks with the timer or by hand"),
    _prj("tracking.time.delete_any", "Tasks", "Delete anyone’s time", "Remove time entries logged by others"),
    _prj("tracking.project.import", "Tasks", "Import tasks", "Bring in tasks from a CSV or another tool’s export"),
    _prj(
        "tracking.development.link",
        "Tasks",
        "Link code",
        "Create branches and link or unlink pull requests, commits and branches",
    ),
    _prj("tracking.sprint.manage", "Planning", "Manage sprints", "Start, close and plan sprints"),
    _prj("tracking.milestone.manage", "Planning", "Edit milestones", "Create milestones and move dates"),
    _prj("tracking.objective.manage", "Planning", "Set objectives", "Create objectives and link tasks"),
    _prj("tracking.epic.manage", "Planning", "Manage epics", "Create and rename epics"),
    _prj("tracking.status.manage", "Planning", "Edit workflow", "Add, rename and reorder statuses"),
    _prj("tracking.field.manage", "Planning", "Manage custom fields", "Create, edit, reorder and delete custom fields"),
    _prj("tracking.comment.create", "Collaboration", "Comment", "Reply and mention teammates"),
    _prj("tracking.comment.edit_own", "Collaboration", "Edit own comments", "Fix typos in your comments"),
    _prj("tracking.comment.delete_any", "Collaboration", "Delete any comment", "Remove anyone’s comment"),
    _prj("tracking.attachment.upload", "Collaboration", "Upload files", "Attach images and code files"),
    _prj("tracking.attachment.delete_any", "Collaboration", "Delete any file", "Remove anyone’s attachment"),
    _prj("tracking.project.manage_members", "Collaboration", "Manage members", "Add people and set their project role"),
    _prj("tracking.dashboard.create", "Reports", "Create dashboards", "Build dashboards and edit the ones you created"),
    _prj(
        "tracking.dashboard.manage",
        "Reports",
        "Manage shared dashboards",
        "Edit, rearrange and delete any shared dashboard",
    ),
    _prj("tracking.report.view", "Reports", "View reports", "Velocity, burndown, cycle time"),
    _prj("tracking.project.view", "Administration", "View project", "See the project, its board and tasks"),
    _prj("tracking.project.update", "Administration", "Project settings", "Rename, change key and description"),
    _prj("tracking.project.archive", "Administration", "Archive project", "Close out finished projects"),
    _prj("tracking.project.delete", "Administration", "Delete project", "Delete the project and its tasks"),
]

BY_CODE: dict[str, PermissionDef] = {p.code: p for p in PERMISSIONS}
SCOPE_OF: dict[str, str] = {p.code: p.scope for p in PERMISSIONS}
WORKSPACE_CODES: list[str] = [p.code for p in PERMISSIONS if p.scope == WORKSPACE]
PROJECT_CODES: list[str] = [p.code for p in PERMISSIONS if p.scope == PROJECT]

# Order used in my_permissions arrays (stable, matches the client's constants).
WORKSPACE_ORDER = [
    "core.workspace.view",
    "core.workspace.update",
    "core.workspace.delete",
    "core.workspace.manage_members",
    "core.roles.manage",
    "tracking.project.create",
    "tracking.project.assign_admin",
    "tracking.integration.manage",
    "core.audit.view",
    "core.modules.manage",
    "core.teams.manage",
]
PROJECT_ORDER = [
    "tracking.project.view",
    "tracking.project.update",
    "tracking.project.archive",
    "tracking.project.delete",
    "tracking.project.manage_members",
    "tracking.objective.manage",
    "tracking.milestone.manage",
    "tracking.epic.manage",
    "tracking.sprint.manage",
    "tracking.status.manage",
    "tracking.field.manage",
    "tracking.task.create",
    "tracking.task.edit_any",
    "tracking.task.edit_own",
    "tracking.task.delete",
    "tracking.task.assign",
    "tracking.task.move",
    "tracking.project.import",
    "tracking.development.link",
    "tracking.time.log",
    "tracking.time.delete_any",
    "tracking.comment.create",
    "tracking.comment.edit_own",
    "tracking.comment.delete_any",
    "tracking.attachment.upload",
    "tracking.attachment.delete_any",
    "tracking.dashboard.create",
    "tracking.dashboard.manage",
    "tracking.report.view",
]
ORDER_INDEX = {c: i for i, c in enumerate(WORKSPACE_ORDER + PROJECT_ORDER)}


def ordered(codes) -> list[str]:
    return sorted(set(codes), key=lambda c: ORDER_INDEX.get(c, 999))


# Permissions that define "ownership"-type invariants (never role names):
OWNER_PERMISSION = "core.workspace.delete"  # the last holder can't be removed or demoted
PROJECT_ADMIN_PERMISSION = "tracking.project.manage_members"  # a project keeps at least one holder


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
        [c for c in WORKSPACE_ORDER if c != "core.workspace.delete"],
        core=["core.workspace.view", "core.workspace.manage_members"],
    ),
    RoleDef(
        "member",
        "Member",
        WORKSPACE,
        "Sees the workspace and joins projects they’re added to.",
        ["core.workspace.view"],
        core=["core.workspace.view"],
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
        [
            c
            for c in PROJECT_ORDER
            if c not in ("tracking.project.archive", "tracking.project.delete", "tracking.project.manage_members")
        ],
        core=["tracking.project.view"],
    ),
    RoleDef(
        "project_member",
        "Member",
        PROJECT,
        "Creates tasks, works their own, comments and uploads.",
        [
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
        core=["tracking.project.view"],
    ),
    RoleDef(
        "viewer",
        "Viewer",
        PROJECT,
        "Read-only access to the board, backlog and goals.",
        ["tracking.project.view"],
        core=["tracking.project.view"],
    ),
]
ROLE_DEF_BY_KEY = {r.key: r for r in DEFAULT_ROLES}
