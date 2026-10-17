"""Platform Stage 4 (docs/platform/stage4-contract.md §1, §5): teams and team members."""

import uuid

import pytest

from core.audit.models import AuditLog
from core.common.testing import UserFactory, add_member, client_for, make_workspace
from core.realtime.models import RealtimeEvent
from core.teams.models import Team, TeamMember
from core.workspaces.models import Workspace

pytestmark = pytest.mark.django_db


@pytest.fixture
def people(ws):
    """Sam is an Admin (core.teams.manage); Kim and Lee are Members; Out is in another workspace."""
    sam = add_member(ws, UserFactory(name="Sam Rivera", email="sam@team.dev"), "admin")
    kim = add_member(ws, UserFactory(name="kim Lo", email="kim@team.dev"))
    lee = add_member(ws, UserFactory(name="Lee Park", email="lee@team.dev"))
    out = UserFactory(name="Out Sider")
    make_workspace(out, name="Elsewhere", slug="elsewhere")
    return {"sam": sam, "kim": kim, "lee": lee, "out": out}


def _create(client, name, slug="platform", **extra):
    return client.post(f"/api/v1/workspaces/{slug}/teams", {"name": name, **extra}, format="json")


def _actions():
    return list(
        AuditLog.objects.filter(action__startswith="core.team.").order_by("created_at").values_list("action", flat=True)
    )


def test_create_list_and_detail(owner, ws, people):
    client = client_for(owner)
    res = _create(client, "  Web ", description="Frontend folks")
    assert res.status_code == 201, res.json()
    body = res.json()
    assert body == {
        "id": body["id"],
        "name": "Web",
        "description": "Frontend folks",
        "memberCount": 0,
        "leadIds": [],
        "createdAt": body["createdAt"],
        "members": [],
    }
    assert _create(client, "api").status_code == 201
    assert _create(client, "Backend").status_code == 201
    # Any member reads; not paginated; sorted by name case-insensitively.
    listed = client_for(people["kim"]).get("/api/v1/workspaces/platform/teams")
    assert listed.status_code == 200
    assert [t["name"] for t in listed.json()] == ["api", "Backend", "Web"]
    assert set(listed.json()[0]) == {"id", "name", "description", "memberCount", "leadIds", "createdAt"}
    detail = client_for(people["lee"]).get(f"/api/v1/teams/{body['id']}")
    assert detail.status_code == 200 and detail.json()["members"] == []
    assert _actions() == ["core.team.created"] * 3


def test_names_are_unique_per_workspace_case_insensitively(owner, ws, people):
    client = client_for(owner)
    assert _create(client, "Web").status_code == 201
    res = _create(client, "WEB")
    assert res.status_code == 409
    assert res.json()["code"] == "team_name_taken"
    # Another workspace may reuse the name.
    assert _create(client_for(people["out"]), "Web", slug="elsewhere").status_code == 201
    # A deleted team frees its name.
    team = Team.objects.get(workspace=ws, name="Web")
    assert client.delete(f"/api/v1/teams/{team.id}").status_code == 204
    assert _create(client, "web").status_code == 201


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"name": ""}, "name"),
        ({"name": "   "}, "name"),
        ({}, "name"),
        ({"name": "x" * 61}, "name"),
        ({"name": 5}, "name"),
        ({"name": "Ok", "description": "d" * 281}, "description"),
        ({"name": "Ok", "description": 7}, "description"),
    ],
)
def test_create_validation(owner, ws, payload, field):
    res = client_for(owner).post("/api/v1/workspaces/platform/teams", payload, format="json")
    assert res.status_code == 422
    assert res.json()["code"] == "validation_failed"
    assert field in res.json()["details"]["fields"]


def test_limits_are_inclusive(owner, ws):
    res = _create(client_for(owner), "x" * 60, description="d" * 280)
    assert res.status_code == 201
    assert _create(client_for(owner), "y", description=None).json()["description"] == ""


def test_writes_need_manage_permission(owner, ws, people):
    team = Team.objects.create(workspace=ws, name="Web")
    kim = client_for(people["kim"])
    assert _create(kim, "Nope").status_code == 403
    assert kim.patch(f"/api/v1/teams/{team.id}", {"name": "X"}, format="json").status_code == 403
    assert kim.delete(f"/api/v1/teams/{team.id}").status_code == 403
    res = kim.post(f"/api/v1/teams/{team.id}/members", {"userId": str(people["lee"].id)}, format="json")
    assert res.status_code == 403
    assert res.json()["details"] == {"permission": "core.teams.manage"}
    # Reads are open to members.
    assert kim.get(f"/api/v1/teams/{team.id}").status_code == 200
    assert kim.get(f"/api/v1/teams/{team.id}/members").status_code == 200
    # An Admin (core.teams.manage) may write.
    assert client_for(people["sam"]).patch(f"/api/v1/teams/{team.id}", {"name": "Y"}, format="json").status_code == 200


def test_update_and_soft_delete(owner, ws, people):
    client = client_for(owner)
    team_id = _create(client, "Web").json()["id"]
    other = _create(client, "Api").json()["id"]
    res = client.patch(f"/api/v1/teams/{team_id}", {"description": "New"}, format="json")
    assert res.status_code == 200
    assert (res.json()["name"], res.json()["description"], res.json()["members"]) == ("Web", "New", [])
    res = client.patch(f"/api/v1/teams/{team_id}", {"name": "Frontend"}, format="json")
    assert res.json()["name"] == "Frontend"
    assert client.patch(f"/api/v1/teams/{team_id}", {"name": "frontend"}, format="json").status_code == 200
    taken = client.patch(f"/api/v1/teams/{other}", {"name": "FRONTEND"}, format="json")
    assert (taken.status_code, taken.json()["code"]) == (409, "team_name_taken")
    assert client.patch(f"/api/v1/teams/{team_id}", {"name": ""}, format="json").status_code == 422
    # A PATCH that changes nothing writes no audit row.
    before = AuditLog.objects.count()
    assert client.patch(f"/api/v1/teams/{team_id}", {"name": "frontend"}, format="json").status_code == 200
    assert AuditLog.objects.count() == before
    assert client.delete(f"/api/v1/teams/{team_id}").status_code == 204
    assert Team.all_objects.get(pk=team_id).deleted_at is not None
    assert client.get(f"/api/v1/teams/{team_id}").status_code == 404
    assert [t["id"] for t in client.get("/api/v1/workspaces/platform/teams").json()] == [other]
    assert _actions() == ["core.team.created"] * 2 + ["core.team.updated"] * 3 + ["core.team.deleted"]


def test_members(owner, ws, people):
    client = client_for(owner)
    team_id = _create(client, "Web").json()["id"]
    url = f"/api/v1/teams/{team_id}/members"
    lee, kim = people["lee"], people["kim"]
    res = client.post(url, {"userId": str(lee.id), "isLead": True}, format="json")
    assert res.status_code == 201, res.json()
    assert res.json() == {
        "userId": str(lee.id),
        "name": "Lee Park",
        "email": "lee@team.dev",
        "avatarUrl": None,
        "isLead": True,
    }
    res = client.post(url, {"userId": str(kim.id)}, format="json")
    assert res.status_code == 201 and res.json()["isLead"] is False
    dup = client.post(url, {"userId": str(kim.id)}, format="json")
    assert (dup.status_code, dup.json()["code"], dup.json()["details"]) == (
        409,
        "already_a_member",
        {"userId": str(kim.id)},
    )
    # Members sorted by name, case-insensitively.
    assert [m["name"] for m in client.get(url).json()] == ["kim Lo", "Lee Park"]
    detail = client.get(f"/api/v1/teams/{team_id}").json()
    assert detail["memberCount"] == 2 and detail["leadIds"] == [str(lee.id)]
    assert [m["userId"] for m in detail["members"]] == [str(kim.id), str(lee.id)]
    # Toggle lead.
    res = client.patch(f"{url}/{kim.id}", {"isLead": True}, format="json")
    assert res.status_code == 200 and res.json()["isLead"] is True
    assert client.patch(f"{url}/{kim.id}", {"isLead": True}, format="json").status_code == 200  # no-op
    assert client.patch(f"{url}/{kim.id}", {"isLead": "yes"}, format="json").status_code == 422
    assert client.patch(f"{url}/{kim.id}", {}, format="json").status_code == 422
    assert sorted(client.get(f"/api/v1/teams/{team_id}").json()["leadIds"]) == sorted([str(lee.id), str(kim.id)])
    # Remove.
    assert client.delete(f"{url}/{kim.id}").status_code == 204
    assert client.delete(f"{url}/{kim.id}").status_code == 404
    assert client.patch(f"{url}/{kim.id}", {"isLead": False}, format="json").status_code == 404
    assert [m["userId"] for m in client.get(url).json()] == [str(lee.id)]
    assert _actions() == [
        "core.team.created",
        "core.team.member_added",
        "core.team.member_added",
        "core.team.member_updated",
        "core.team.member_removed",
    ]


def test_member_validation(owner, ws, people):
    client = client_for(owner)
    team_id = _create(client, "Web").json()["id"]
    url = f"/api/v1/teams/{team_id}/members"
    for payload in ({}, {"userId": ""}, {"userId": "not-a-uuid"}, {"userId": 5}):
        assert client.post(url, payload, format="json").status_code == 422, payload
    assert client.post(url, {"userId": str(people["kim"].id), "isLead": "y"}, format="json").status_code == 422
    for outsider in (people["out"].id, uuid.uuid4()):
        res = client.post(url, {"userId": str(outsider)}, format="json")
        assert (res.status_code, res.json()["code"]) == (400, "not_a_workspace_member")
        assert res.json()["details"] == {"userId": str(outsider)}


def test_tenant_rule(owner, ws, people):
    """A team in another workspace (or an unknown one) is a 404 for every route."""
    theirs = Team.objects.create(workspace=Workspace.objects.get(slug="elsewhere"), name="Theirs")
    client = client_for(owner)
    for team_id in (theirs.id, uuid.uuid4()):
        assert client.get(f"/api/v1/teams/{team_id}").status_code == 404
        assert client.patch(f"/api/v1/teams/{team_id}", {"name": "Mine"}, format="json").status_code == 404
        assert client.delete(f"/api/v1/teams/{team_id}").status_code == 404
        assert client.get(f"/api/v1/teams/{team_id}/members").status_code == 404
        res = client.post(f"/api/v1/teams/{team_id}/members", {"userId": str(owner.id)}, format="json")
        assert res.status_code == 404
        assert client.delete(f"/api/v1/teams/{team_id}/members/{owner.id}").status_code == 404
    assert client.get("/api/v1/workspaces/elsewhere/teams").status_code == 404
    assert Team.objects.get(pk=theirs.pk).name == "Theirs"


def test_removing_a_workspace_member_removes_their_team_memberships(owner, ws, people):
    client = client_for(owner)
    a = _create(client, "A").json()["id"]
    b = _create(client, "B").json()["id"]
    kim = people["kim"]
    for team_id in (a, b):
        client.post(f"/api/v1/teams/{team_id}/members", {"userId": str(kim.id)}, format="json")
    client.post(f"/api/v1/teams/{a}/members", {"userId": str(people["lee"].id)}, format="json")
    assert client.delete(f"/api/v1/workspaces/platform/members/{kim.id}").status_code == 204
    assert not TeamMember.objects.filter(user=kim).exists()
    assert TeamMember.objects.filter(user=people["lee"]).count() == 1


def test_team_writes_publish_no_realtime_event(owner, ws, people):
    RealtimeEvent.objects.all().delete()
    client = client_for(owner)
    team_id = _create(client, "Web").json()["id"]
    client.patch(f"/api/v1/teams/{team_id}", {"name": "Web 2"}, format="json")
    client.post(f"/api/v1/teams/{team_id}/members", {"userId": str(people["kim"].id)}, format="json")
    client.patch(f"/api/v1/teams/{team_id}/members/{people['kim'].id}", {"isLead": True}, format="json")
    client.delete(f"/api/v1/teams/{team_id}/members/{people['kim'].id}")
    client.delete(f"/api/v1/teams/{team_id}")
    assert not RealtimeEvent.objects.exists()


def test_concurrent_duplicates_answer_409(owner, ws, people, monkeypatch):
    """The database constraints back the pre-checks (a race between two requests)."""
    from core.teams import services

    client = client_for(owner)
    team_id = _create(client, "Web").json()["id"]
    monkeypatch.setattr(services, "_ensure_name_free", lambda *a, **k: None)
    res = _create(client, "web")
    assert (res.status_code, res.json()["code"]) == (409, "team_name_taken")
    client.post(f"/api/v1/teams/{team_id}/members", {"userId": str(people["kim"].id)}, format="json")
    real_filter = TeamMember.objects.filter

    class _NoDupCheck:
        def exists(self):
            return False

    monkeypatch.setattr(
        TeamMember.objects,
        "filter",
        lambda *a, **k: _NoDupCheck() if set(k) == {"team", "user_id"} else real_filter(*a, **k),
    )
    res = client.post(f"/api/v1/teams/{team_id}/members", {"userId": str(people["kim"].id)}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "already_a_member")
