"""Permission matrix: for every API route and method, requests from roles that must pass the access
layer and roles that must be refused. The table is checked against the URL configuration, so a new
endpoint without an entry here fails the suite.

"Allowed" means the request got past authentication and access control (any status except 401,
403 and 404). "Denied" means 401, 403 or 404, depending on who is asking.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pytest
from django.urls import URLPattern, URLResolver, get_resolver, reverse

from apps.common.testing import client_for

from .matrix_world import ACTORS, World, build_world

PUBLIC = "public"  # no authentication needed
ANY = ("owner", "ws_admin", "ws_member", "manager", "pmember", "viewer", "outsider")


@dataclass(frozen=True)
class Row:
    name: str
    method: str
    kwargs: Callable[[World], dict[str, Any]] = field(default=lambda w: {})
    allow: tuple[str, ...] = ()
    deny: tuple[str, ...] = ()
    body: Callable[[World], Any] | None = None
    query: str = ""


def S(w):
    return {"slug": w.ws.slug}


ROWS: list[Row] = [
    # ── public ──
    Row("api-health", "GET", allow=(PUBLIC,)),
    Row("auth-register", "POST", allow=(PUBLIC,)),
    Row("auth-login", "POST", allow=(PUBLIC,)),
    Row("auth-refresh", "POST", allow=(PUBLIC,)),
    Row("auth-logout", "POST", allow=(PUBLIC,)),
    Row("auth-forgot-password", "POST", allow=(PUBLIC,)),
    Row("auth-reset-password", "POST", allow=(PUBLIC,)),
    Row("invite-public", "GET", lambda w: {"token": w.invite_token}, allow=(PUBLIC,)),
    Row("invite-accept", "POST", lambda w: {"token": w.invite_token}, allow=(PUBLIC,)),
    # ── authenticated, no scope ──
    Row("auth-me", "GET", allow=ANY, deny=("anon",)),
    Row("auth-me", "PATCH", allow=ANY, deny=("anon",), body=lambda w: {}),
    Row("auth-change-password", "PUT", allow=("owner",), deny=("anon",), body=lambda w: {}),
    Row("workspace-list", "GET", allow=ANY, deny=("anon",)),
    Row("workspace-list", "POST", allow=("ws_member",), deny=("anon",), body=lambda w: {"name": "N"}),
    Row("permission-catalogue", "GET", allow=ANY, deny=("anon",)),
    # ── workspace scope ──
    Row("workspace-detail", "GET", S, allow=("owner", "ws_member", "pmember"), deny=("outsider", "anon")),
    Row(
        "workspace-detail",
        "PATCH",
        S,
        allow=("owner", "ws_admin"),
        deny=("ws_member", "manager", "outsider"),
        body=lambda w: {},
    ),
    Row(
        "workspace-detail",
        "DELETE",
        S,
        allow=("owner",),
        deny=("ws_admin", "ws_member", "manager", "outsider"),
        body=lambda w: {"confirm": "no"},
    ),
    Row("workspace-slug-availability", "GET", S, allow=("owner", "ws_member"), deny=("outsider",), query="?q=abc"),
    Row("workspace-members", "GET", S, allow=("owner", "ws_member", "viewer"), deny=("outsider", "anon")),
    Row(
        "workspace-member-detail",
        "PATCH",
        lambda w: {"slug": w.ws.slug, "user_id": w.users["pmember"].id},
        allow=("owner", "ws_admin"),
        deny=("ws_member", "manager", "outsider"),
        body=lambda w: {"roleId": str(w.role("member").id)},
    ),
    Row(
        "workspace-member-detail",
        "DELETE",
        lambda w: {"slug": w.ws.slug, "user_id": w.users["viewer"].id},
        allow=("owner", "ws_admin"),
        deny=("ws_member", "manager", "outsider"),
    ),
    Row("workspace-invites", "GET", S, allow=("owner", "ws_admin"), deny=("ws_member", "manager", "outsider")),
    Row(
        "workspace-invites",
        "POST",
        S,
        allow=("owner", "ws_admin"),
        deny=("ws_member", "pmember", "outsider"),
        body=lambda w: {"emails": ["new@x.dev"], "roleId": str(w.role("member").id)},
    ),
    Row(
        "workspace-invite-detail",
        "DELETE",
        lambda w: {"slug": w.ws.slug, "invite_id": w.invite.id},
        allow=("owner", "ws_admin"),
        deny=("ws_member", "outsider"),
    ),
    Row(
        "workspace-invite-resend",
        "POST",
        lambda w: {"slug": w.ws.slug, "invite_id": w.invite.id},
        allow=("owner", "ws_admin"),
        deny=("ws_member", "outsider"),
    ),
    Row("workspace-access-requests", "POST", S, allow=("ws_member",), deny=("outsider", "anon")),
    Row("workspace-access-request-mine", "GET", S, allow=("ws_member", "owner"), deny=("outsider",)),
    Row("workspace-access-request-mine", "DELETE", S, allow=("ws_member",), deny=("outsider",)),
    Row("workspace-roles", "GET", S, allow=("owner", "ws_member"), deny=("outsider", "anon")),
    Row(
        "workspace-roles",
        "POST",
        S,
        allow=("owner", "ws_admin"),
        deny=("ws_member", "manager", "outsider"),
        body=lambda w: {"name": "Custom", "scope": "project", "permissions": ["project.view"]},
    ),
    Row(
        "role-detail",
        "PATCH",
        lambda w: {"role_id": w.custom_role.id},
        allow=("owner", "ws_admin"),
        deny=("ws_member", "manager", "outsider"),
        body=lambda w: {"description": "x"},
    ),
    Row(
        "role-detail",
        "DELETE",
        lambda w: {"role_id": w.custom_role.id},
        allow=("owner", "ws_admin"),
        deny=("ws_member", "manager", "outsider"),
    ),
    Row(
        "role-permissions",
        "PUT",
        lambda w: {"role_id": w.custom_role.id},
        allow=("owner", "ws_admin"),
        deny=("ws_member", "manager", "outsider"),
        body=lambda w: {"permissions": ["project.view"]},
    ),
]


def all_rows() -> list[Row]:
    from . import matrix_rows

    return ROWS + matrix_rows.ROWS


def _api_routes() -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()

    def walk(patterns, prefix=""):
        for p in patterns:
            if isinstance(p, URLResolver):
                walk(p.url_patterns, prefix + str(p.pattern))
            elif isinstance(p, URLPattern) and (prefix + str(p.pattern)).startswith("api/v1/"):
                view = getattr(p.callback, "view_class", None) or getattr(p.callback, "cls", None)
                methods = getattr(p.callback, "actions", None)
                if view is None:
                    continue
                names = methods or [m for m in ("get", "post", "put", "patch", "delete") if hasattr(view, m)]
                for m in names:
                    found.add((p.name, m.upper()))

    walk(get_resolver().url_patterns)
    return found


def test_every_api_route_has_a_matrix_entry():
    covered = {(r.name, r.method) for r in all_rows()}
    missing = sorted(_api_routes() - covered)
    assert not missing, f"Add permission-matrix rows for: {missing}"
    for r in all_rows():
        assert r.allow or r.deny, r
        if PUBLIC not in r.allow:
            assert r.deny, f"{r.name} {r.method} needs at least one denied role"


def _cases():
    for r in all_rows():
        for actor in r.allow:
            yield pytest.param(r, actor, True, id=f"{r.name}-{r.method}-{actor}-allow")
        for actor in r.deny:
            yield pytest.param(r, actor, False, id=f"{r.name}-{r.method}-{actor}-deny")


@pytest.mark.django_db
@pytest.mark.parametrize(("row", "actor", "allowed"), list(_cases()))
def test_permission_matrix(row: Row, actor: str, allowed: bool):
    w = build_world()
    user = None if actor in (PUBLIC, "anon") else w.users[actor]
    client = client_for(user)
    url = reverse(row.name, kwargs=row.kwargs(w)) + row.query
    payload = row.body(w) if row.body else None
    res = (
        getattr(client, row.method.lower())(url, payload, format="json")
        if payload is not None
        else getattr(client, row.method.lower())(url)
    )
    if actor == PUBLIC:
        # No access control on public endpoints: they answer for themselves (401 = bad credentials).
        assert res.status_code != 403 and res.status_code < 500, res.content[:300]
    elif allowed:
        assert res.status_code not in (401, 403, 404), f"{actor} should pass: {res.status_code} {res.content[:300]!r}"
    else:
        assert res.status_code in (401, 403, 404), f"{actor} should be refused: {res.status_code} {res.content[:300]!r}"
        if actor == "anon":
            assert res.status_code == 401
        if actor == "outsider":
            assert res.status_code == 404, "non-members of a workspace must get 404"


assert set(ACTORS) >= set(ANY)
