"""Test support shared by every app: factories and helpers that build real scopes through services."""

from __future__ import annotations

from typing import Any

import factory
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts.models import User

PASSWORD = "Str0ng!pass"


class UserFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = User
        skip_postgeneration_save = True

    email = factory.Sequence(lambda n: f"user{n}@team.dev")
    name = factory.Sequence(lambda n: f"User {n}")
    password = factory.PostGenerationMethodCall("set_password", PASSWORD)

    @factory.post_generation
    def _save(obj, create, extracted, **kwargs):
        if create:
            obj.save()


def client_for(user: User | None) -> APIClient:
    """An API client authenticated with a real access token (no force_authenticate)."""
    client = APIClient()
    if user is not None:
        token = RefreshToken.for_user(user).access_token
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return client


def make_workspace(owner: User | None = None, name: str = "Platform team", slug: str | None = None):
    from apps.workspaces.services import create_workspace

    owner = owner or UserFactory()
    return create_workspace(owner, name=name, slug=slug)


def role(ws: Any, key: str):
    return ws.roles.get(system_key=key)


def add_member(ws: Any, user: User | None = None, key: str = "member"):
    from apps.workspaces.models import WorkspaceMember

    user = user or UserFactory()
    WorkspaceMember.objects.update_or_create(workspace=ws, user=user, defaults={"role": role(ws, key)})
    return user


def add_project_member(project: Any, user: User | None = None, key: str = "project_member", ws_key: str = "member"):
    from apps.projects.models import ProjectMember
    from apps.workspaces.models import WorkspaceMember

    user = user or UserFactory()
    if not WorkspaceMember.objects.filter(workspace=project.workspace, user=user).exists():
        add_member(project.workspace, user, ws_key)
    ProjectMember.objects.update_or_create(project=project, user=user, defaults={"role": role(project.workspace, key)})
    return user


def make_project(
    ws: Any, creator: User | None = None, key: str = "PRJ", name: str = "Platform Rebuild", template: str = "scrum"
):
    from apps.projects.services import create_project
    from apps.workspaces.models import WorkspaceMember

    if creator is None:
        creator = WorkspaceMember.objects.filter(workspace=ws, role__system_key="owner").first().user
    return create_project(creator, ws, {"name": name, "key": key, "template": template})
