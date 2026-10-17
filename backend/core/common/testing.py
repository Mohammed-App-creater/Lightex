"""Test support shared by every app: factories and helpers that build real scopes through services."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
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


@contextmanager
def shared_world(django_db_blocker: Any) -> Iterator[Callable[..., Any]]:
    """Build test data once for a whole module or class, and roll every test back to it.

    For a `scope="module"` (or `"class"`) fixture: opens an outer transaction, yields `build(func, *args)` which runs
    `func` inside it (database access unblocked, `on_commit` callbacks run at once, as the root conftest does for
    tests), and rolls the whole transaction back when the scope ends. Each test still uses the `db` fixture: its own
    transaction becomes a savepoint inside the outer one, so whatever a test writes is undone before the next test,
    and every test sees exactly the data `build` created.

        @pytest.fixture(scope="module")
        def matrix_world(django_db_setup, django_db_blocker):
            with shared_world(django_db_blocker) as build:
                yield build(build_world)

    Python objects are shared too: tests should read ids and names from the world and fetch fresh rows, not rely on
    in-memory state another test may have changed. Not for `transactional_db` tests (they flush the tables).
    """
    from unittest import mock

    from django.db import transaction

    def run_now(func: Callable[[], Any], using: Any = None, robust: bool = False) -> None:
        func()

    with django_db_blocker.unblock():
        outer = transaction.atomic()
        outer.__enter__()

    def build(func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        with django_db_blocker.unblock(), mock.patch.object(transaction, "on_commit", run_now):
            return func(*args, **kwargs)

    try:
        yield build
    finally:
        with django_db_blocker.unblock():
            transaction.set_rollback(True)
            outer.__exit__(None, None, None)
