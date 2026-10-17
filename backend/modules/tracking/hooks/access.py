"""The `project` scope provider: project-scope permissions come from the user's ProjectMember role."""

from __future__ import annotations

from typing import Any

from core.access import scopes
from core.access.catalogue import PROJECT

# An archived project is read-only: everything else is withheld until it is unarchived.
ARCHIVED_ALLOWED = frozenset(
    {
        "tracking.project.view",
        "tracking.project.archive",
        "tracking.project.delete",
        "tracking.project.manage_members",
        "tracking.report.view",
    }
)


class ProjectScope(scopes.ScopeProvider):
    scope = PROJECT
    model_label = "projects.project"
    view_permission = "tracking.project.view"

    def load_permissions(
        self, user: Any, ids: list[Any], *, include_deleted: bool = False
    ) -> dict[Any, frozenset[str]]:
        from modules.tracking.projects.models import ProjectMember

        found: dict[Any, set[str]] = {}
        status: dict[Any, str] = {}
        only_live = {} if include_deleted else {"project__deleted_at__isnull": True}
        rows = ProjectMember.objects.filter(
            user_id=user.pk,
            project_id__in=ids,
            **only_live,
            project__workspace__deleted_at__isnull=True,
            project__workspace__members__user_id=user.pk,
            project__workspace__members__status="active",
        ).values_list("project_id", "project__status", "role__permissions__code", "role__permissions__scope")
        for pid, project_status, code, code_scope in rows:
            found.setdefault(pid, set())
            status[pid] = project_status
            if code and code_scope == PROJECT:
                found[pid].add(code)
        out: dict[Any, frozenset[str]] = {}
        for pid in ids:
            perms = found.get(pid)
            if perms is None:
                out[pid] = frozenset()
            elif status.get(pid) == "archived" and not include_deleted:
                out[pid] = frozenset(perms & ARCHIVED_ALLOWED)
            else:
                out[pid] = frozenset(perms)
        return out

    def is_member(self, user: Any, scope_id: Any) -> bool:
        from modules.tracking.projects.models import ProjectMember

        return ProjectMember.objects.filter(
            user_id=user.pk,
            project_id=scope_id,
            project__workspace__members__user_id=user.pk,
            project__workspace__members__status="active",
        ).exists()

    def member_scope_ids(self, user: Any) -> Any:
        from modules.tracking.projects.models import ProjectMember

        return ProjectMember.objects.filter(user=user, project__deleted_at__isnull=True).values("project_id")

    def visible_ids(self, user: Any, workspace: Any) -> frozenset[str]:
        """Projects of the workspace where the user has `project.view` (archived included, soft-deleted excluded)."""
        from core.access import services as access
        from modules.tracking.projects.models import ProjectMember

        ids = list(
            ProjectMember.objects.filter(
                user_id=user.pk, project__workspace=workspace, project__deleted_at__isnull=True
            ).values_list("project_id", flat=True)
        )
        perms = access.prefetch_project_permissions(user, ids)
        return frozenset(str(pid) for pid, codes in perms.items() if self.view_permission in codes)

    def role_assignments(self, role: Any) -> Any:
        from modules.tracking.projects.models import ProjectMember

        return ProjectMember.objects.filter(role=role)

    def get_visible(self, user: Any, scope_id: Any) -> Any:
        from modules.tracking.projects.selectors import project_for

        return project_for(user, scope_id)

    def workspace_of(self, scope_id: Any) -> Any:
        from modules.tracking.projects.models import Project

        return Project.objects.filter(pk=scope_id).values_list("workspace_id", flat=True).first()


def register() -> None:
    scopes.register_scope_provider(ProjectScope())
