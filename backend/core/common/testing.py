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


def add_member(ws: Any, user: User | None = None, key: str = "member"):
    from core.workspaces.models import WorkspaceMember

    user = user or UserFactory()
    WorkspaceMember.objects.update_or_create(workspace=ws, user=user, defaults={"role": role(ws, key)})
    return user
