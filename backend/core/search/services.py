"""Search fan-out. Modules register providers; `GET /search` and `GET /workspaces/{slug}/search` ask each one.

    register_search_provider("tracking", TrackingSearch())

A provider declares the result types it answers (`types`, for the workspace palette, and `global_types`, for the
cross-workspace full-text search) and returns permission-filtered result dicts. Each result carries `type` plus the
generic `targetType`, `targetId`, `title` and `link`; the rest of its shape is the provider's.
People (`user`) are core's own workspace-search type.
"""

from __future__ import annotations

import re
from typing import Any

from django.contrib.postgres.search import SearchQuery
from django.db.models import Q

from core.accounts.serializers import UserSerializer


class SearchProvider:
    #: Result types in the workspace search (`filter[type]`).
    types: tuple[str, ...] = ()
    #: Result types in the global full-text search (`type`).
    global_types: tuple[str, ...] = ()

    def search(self, user: Any, workspace: Any, query: str, limit: int, types: set[str]) -> list[dict[str, Any]]:
        """Workspace search: results of the requested `types` the user may see."""
        return []

    def search_all(self, user: Any, query: str, limit: int, types: set[str]) -> list[dict[str, Any]]:
        """Global search across every workspace the user belongs to."""
        return []


_PROVIDERS: dict[str, SearchProvider] = {}


def register_search_provider(module: str, provider: SearchProvider) -> None:
    _PROVIDERS[module] = provider


def unregister_search_provider(module: str) -> None:
    _PROVIDERS.pop(module, None)


def providers() -> list[SearchProvider]:
    return list(_PROVIDERS.values())


def workspace_types() -> list[str]:
    out = [t for p in providers() for t in p.types]
    return [*dict.fromkeys(out), "user"]


def global_types() -> list[str]:
    return list(dict.fromkeys(t for p in providers() for t in p.global_types))


def ts_query(q: str) -> SearchQuery | None:
    """Prefix-matching query for type-ahead ("boa" finds "board") OR an English websearch query."""
    words = re.findall(r"[A-Za-z0-9]+", q.lower())[:8]
    if not words:
        return None
    prefix = SearchQuery(" & ".join(f"{w}:*" for w in words), search_type="raw", config="simple")
    return prefix | SearchQuery(q, search_type="websearch", config="english")


def workspace_search(user: Any, workspace: Any, q: str, types: list[str], limit: int) -> list[dict[str, Any]]:
    """The command palette's search: every provider's types, then people, in one workspace."""
    from core.workspaces.models import WorkspaceMember

    want = set(types) or set(workspace_types())
    q = q.strip()
    out: list[dict[str, Any]] = []
    for provider in providers():
        asked = want & set(provider.types)
        if asked:
            out.extend(provider.search(user, workspace, q, limit, asked))
    if "user" in want:
        members = WorkspaceMember.objects.filter(workspace=workspace, status="active").select_related("user", "role")
        if q:
            members = members.filter(Q(user__name__icontains=q) | Q(user__email__icontains=q))
        out.extend(
            {
                "type": "user",
                "user": UserSerializer(m.user).data,
                "roleName": m.role.name,
                "targetType": "core.user",
                "targetId": str(m.user_id),
                "title": m.user.name,
                "link": None,
            }
            for m in members.order_by("user__name")[:limit]
        )
    return out


def global_search(user: Any, q: str, kind: str | None, limit: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for provider in providers():
        asked = {kind} & set(provider.global_types) if kind else set(provider.global_types)
        if asked:
            out.extend(provider.search_all(user, q, limit, asked))
    return out
