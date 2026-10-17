"""Scope providers: how `can()` evaluates permissions of a scope that a module owns.

Core owns the `workspace` scope. Any other scope in the permission catalogue (today `project`) is provided by a
module, which registers a provider in its AppConfig `ready()`:

    register_scope_provider(ProjectScope())

`can(user, code, obj)` stays the single decision point: it dispatches on `obj._meta.label_lower` to the provider and
checks `code` against the permissions the provider loads. Core never imports the module.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


class ScopeProvider:
    #: The catalogue scope this provider answers for (for example "project").
    scope: str = ""
    #: `Model._meta.label_lower` of the scope object (for example "projects.project").
    model_label: str = ""
    #: The permission that means "can see this scope" (realtime stream, presence roster).
    view_permission: str = ""

    def load_permissions(
        self, user: Any, ids: list[Any], *, include_deleted: bool = False
    ) -> dict[Any, frozenset[str]]:
        """{scope id: codes the user holds there}, one entry per requested id (empty when not a member)."""
        raise NotImplementedError

    def is_member(self, user: Any, scope_id: Any) -> bool:
        raise NotImplementedError

    def member_scope_ids(self, user: Any) -> Any:
        """A values queryset (or list) of live scope ids the user belongs to."""
        raise NotImplementedError

    def visible_ids(self, user: Any, workspace: Any) -> frozenset[str]:
        """Scope ids in the workspace where the user holds `view_permission`."""
        raise NotImplementedError

    def role_assignments(self, role: Any) -> Any:
        """A queryset of membership rows using `role` (supports `.exists()`, `.values("user")`, `.update(role=)`)."""
        raise NotImplementedError

    def get_visible(self, user: Any, scope_id: Any) -> Any:
        """The scope object if the user may see it; raises the module's 404 / 403 otherwise."""
        raise NotImplementedError

    def workspace_of(self, scope_id: Any) -> Any:
        raise NotImplementedError


_PROVIDERS: dict[str, ScopeProvider] = {}


def register_scope_provider(provider: ScopeProvider) -> None:
    _PROVIDERS[provider.scope] = provider


def provider(scope: str) -> ScopeProvider | None:
    return _PROVIDERS.get(scope)


def provider_for_label(label: str) -> ScopeProvider | None:
    return next((p for p in _PROVIDERS.values() if p.model_label == label), None)


def providers() -> Iterable[ScopeProvider]:
    return list(_PROVIDERS.values())
