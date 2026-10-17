"""Test support shared by every app: factories and helpers that build real scopes through services."""

from __future__ import annotations

from typing import Any

import factory
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from core.accounts.models import User

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


def make_workspace(
    owner: User | None = None, name: str = "Platform team", slug: str | None = None, modules: list[str] | None = None
):
    from core.workspaces.services import create_workspace

    owner = owner or UserFactory()
    return create_workspace(owner, name=name, slug=slug, modules=modules)


def role(ws: Any, key: str):
    return ws.roles.get(system_key=key)


def add_member(ws: Any, user: User | None = None, key: str | list[str] = "member"):
    """Makes `user` a member of `ws` with the role(s) named by system key (replacing any roles they had)."""
    from core.workspaces.models import WorkspaceMember
    from core.workspaces.services import set_member_roles

    user = user or UserFactory()
    keys = [key] if isinstance(key, str) else key
    member, _ = WorkspaceMember.objects.get_or_create(workspace=ws, user=user)
    set_member_roles(member, [role(ws, k) for k in keys])
    user.__dict__.pop("_lx_access_cache", None)
    return user


def set_roles(ws: Any, user: User, *roles: Any) -> None:
    """Gives an existing member exactly `roles` (Role objects or ids)."""
    from core.access.models import Role
    from core.workspaces.models import WorkspaceMember
    from core.workspaces.services import set_member_roles

    member = WorkspaceMember.objects.get(workspace=ws, user=user)
    set_member_roles(member, [r if isinstance(r, Role) else Role.objects.get(pk=r) for r in roles])
    user.__dict__.pop("_lx_access_cache", None)


def make_member(ws: Any, user: User, *roles: Any, **fields: Any):
    """Creates a membership holding `roles` (Role objects or ids)."""
    from core.access.models import Role
    from core.workspaces.services import add_workspace_member

    return add_workspace_member(
        ws, user, [r if isinstance(r, Role) else Role.objects.get(pk=r) for r in roles], **fields
    )
