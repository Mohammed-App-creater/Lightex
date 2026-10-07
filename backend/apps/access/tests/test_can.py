import pytest
from django.contrib.auth.models import AnonymousUser
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.access import catalogue
from apps.access.models import Permission
from apps.access.services import (
    can,
    invalidate,
    is_project_member,
    is_workspace_member,
    my_permissions,
    prefetch_project_permissions,
    project_permissions,
    sync_permission_catalogue,
    workspace_permissions,
)
from apps.common.testing import UserFactory, add_member, make_workspace, role
from apps.projects.models import Project, ProjectMember
from apps.workspaces.models import WorkspaceMember

pytestmark = pytest.mark.django_db


def project_in(ws, key="PRJ"):
    return Project.objects.create(workspace=ws, key=key, name=f"Project {key}")


def join(project, user, key):
    ProjectMember.objects.create(project=project, user=user, role=role(project.workspace, key))


def test_workspace_owner_without_project_membership_has_no_project_access(owner, ws):
    project = project_in(ws)
    assert can(owner, "workspace.delete", ws)
    assert can(owner, "project.create", ws)
    assert not can(owner, "project.view", project)
    assert project_permissions(owner, project) == frozenset()
    assert my_permissions(owner, project) == []


def test_project_admin_gets_nothing_at_workspace_level(owner, ws):
    project = project_in(ws)
    lead = add_member(ws, key="member")
    join(project, lead, "project_admin")
    invalidate(lead)
    assert can(lead, "project.delete", project)
    assert not can(lead, "workspace.update", ws)
    assert not can(lead, "project.create", ws)  # workspace-scope code, despite its name


def test_codes_are_only_checked_in_their_own_scope(owner, ws):
    project = project_in(ws)
    join(project, owner, "project_admin")
    assert not can(owner, "project.view", ws)  # project code against a workspace
    assert not can(owner, "workspace.view", project)  # workspace code against a project
    with pytest.raises(ValueError):
        can(owner, "made.up", ws)
    with pytest.raises(TypeError):
        can(owner, "workspace.view", owner)


def test_each_default_role_gets_exactly_its_catalogue_permissions(owner, ws):
    project = project_in(ws)
    for rdef in catalogue.DEFAULT_ROLES:
        user = UserFactory()
        if rdef.scope == "workspace":
            WorkspaceMember.objects.create(workspace=ws, user=user, role=role(ws, rdef.key))
            assert set(workspace_permissions(user, ws)) == set(rdef.permissions), rdef.key
        else:
            add_member(ws, user, "member")
            join(project, user, rdef.key)
            assert set(project_permissions(user, project)) == set(rdef.permissions), rdef.key


def test_removed_or_deactivated_member_loses_everything(owner, ws):
    project = project_in(ws)
    user = add_member(ws, key="admin")
    join(project, user, "manager")
    assert can(user, "task.create", project)
    WorkspaceMember.objects.filter(user=user).update(status="deactivated")
    invalidate(user)
    assert not can(user, "workspace.view", ws)
    assert not can(user, "task.create", project)
    assert not is_workspace_member(user, ws)
    assert not is_project_member(user, project)


def test_deleted_workspace_and_project_grant_nothing(owner, ws):
    project = project_in(ws)
    join(project, owner, "project_admin")
    project.deleted_at = timezone.now()
    project.save()
    assert not can(owner, "project.view", project)
    ws.deleted_at = timezone.now()
    ws.save()
    invalidate(owner)
    assert not can(owner, "workspace.view", ws)


def test_archived_project_is_read_only(owner, ws):
    project = project_in(ws)
    join(project, owner, "project_admin")
    project.status = "archived"
    project.save()
    assert can(owner, "project.view", project)
    assert can(owner, "project.archive", project)  # so it can be unarchived
    assert not can(owner, "task.create", project)
    assert not can(owner, "sprint.manage", project)


def test_anonymous_and_inactive_users(owner, ws):
    assert not can(AnonymousUser(), "workspace.view", ws)
    assert workspace_permissions(AnonymousUser(), ws) == frozenset()
    assert project_permissions(AnonymousUser(), project_in(ws)) == frozenset()
    assert prefetch_project_permissions(AnonymousUser(), []) == {}
    assert not is_workspace_member(AnonymousUser(), ws)
    owner.is_active = False
    assert not can(owner, "workspace.view", ws)


def test_permissions_are_cached_per_user_instance(owner, ws):
    project = project_in(ws)
    join(project, owner, "project_admin")
    can(owner, "workspace.view", ws)
    can(owner, "project.view", project)
    with CaptureQueriesContext(connection) as ctx:
        for _ in range(5):
            can(owner, "workspace.update", ws)
            can(owner, "task.create", project)
    assert len(ctx.captured_queries) == 0
    invalidate(owner)
    with CaptureQueriesContext(connection) as ctx:
        can(owner, "workspace.update", ws)
    assert len(ctx.captured_queries) == 1


def test_prefetch_loads_many_projects_in_one_query(owner, ws):
    projects = [project_in(ws, k) for k in ("AA", "BB", "CC")]
    join(projects[0], owner, "viewer")
    join(projects[1], owner, "project_admin")
    with CaptureQueriesContext(connection) as ctx:
        perms = prefetch_project_permissions(owner, projects)
    assert len(ctx.captured_queries) == 1
    assert perms[projects[0].pk] == frozenset({"project.view"})
    assert "project.delete" in perms[projects[1].pk]
    assert perms[projects[2].pk] == frozenset()


def test_my_permissions_order_is_stable(owner, ws):
    assert my_permissions(owner, ws) == catalogue.WORKSPACE_ORDER


def test_catalogue_sync_is_idempotent_and_repairs_drift():
    assert sync_permission_catalogue() == (0, 0, 0)
    Permission.objects.filter(code="task.move").update(label="Changed")
    Permission.objects.create(code="stale.perm", scope="project", group="X", label="X", description="X")
    Permission.objects.filter(code="report.view").delete()
    created, updated, removed = sync_permission_catalogue()
    assert (created, updated, removed) == (1, 1, 1)
    assert Permission.objects.count() == len(catalogue.PERMISSIONS)


def test_sync_command(capsys):
    from django.core.management import call_command

    call_command("sync_permissions")
    assert "Permissions synced" in capsys.readouterr().out


def test_seed_roles_resyncs_missing_catalogue(db):
    Permission.objects.all().delete()
    ws = make_workspace(UserFactory(), slug="fresh")
    assert ws.roles.get(system_key="owner").permissions.count() == len(catalogue.WORKSPACE_ORDER)


def test_scoped_permission_edge_cases(owner, ws):
    from rest_framework.test import APIRequestFactory

    from apps.access.models import Role
    from apps.access.permissions import ScopedPermission, ScopedView
    from apps.common.exceptions import ApiError

    class Undeclared(ScopedView):
        required = {"GET": "workspace.view"}

        def get_scope(self):
            return ws

    factory = APIRequestFactory()
    perm = ScopedPermission()
    view = Undeclared()
    anon = factory.get("/")
    anon.user = AnonymousUser()
    assert perm.has_permission(anon, view) is False
    options = factory.options("/")
    options.user = owner
    assert perm.has_permission(options, view) is True
    post = factory.post("/")
    post.user = owner
    with pytest.raises(ApiError):  # fail closed for an undeclared method
        perm.has_permission(post, view)
    assert str(Permission.objects.get(code="task.move")) == "task.move"
    assert str(Role.objects.filter(workspace=ws, system_key="owner").get()) == "Owner (workspace)"
