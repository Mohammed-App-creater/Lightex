"""Presence P1–P3 (docs/v2/33-dashboards-presence.md §2.8, §5.3). Volatile `presence.updated` events are not stored,
so a subscription on the in-process hub captures them."""

import datetime as dt
import queue
import uuid

import pytest
from django.utils import timezone
from freezegun import freeze_time

from apps.common.testing import UserFactory, add_member, client_for
from apps.dashboards.models import Dashboard
from apps.realtime.hub import WAKE, hub
from apps.realtime.models import PresenceSession
from apps.realtime.presence import sweep_presence
from apps.tasks.services import create_task

pytestmark = pytest.mark.django_db
SLUG = "platform"


def _sid():
    return str(uuid.uuid4())


def _put(user, sid, body):
    return client_for(user).put(f"/api/v1/workspaces/{SLUG}/presence/{sid}", body, format="json")


def board(world, **extra):
    return {"location": {"kind": "board", "id": str(world.project.pk)}, "state": "viewing", **extra}


def at_task(task, **extra):
    return {"location": {"kind": "task", "id": str(task.pk)}, "state": "viewing", **extra}


@pytest.fixture
def listen(world):
    sub = hub.subscribe(str(world.ws.pk), frozenset({str(world.project.pk)}), str(world.owner.pk))

    def drain():
        out = []
        while True:
            try:
                item = sub.queue.get_nowait()
            except queue.Empty:
                return out
            if item is not WAKE:
                out.append(item)

    return drain


@pytest.fixture
def task(world):
    return create_task(world.owner, world.project, {"title": "PRJ task"})


# ── P1 ──


def test_heartbeat_upserts_and_returns_the_project_roster(world, task):
    sid = _sid()
    res = _put(world.sam, sid, at_task(task))
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["heartbeatSec"] == 20
    row = PresenceSession.objects.get(user=world.sam, session_id=sid)
    assert body["expiresAt"].startswith(row.expires_at.strftime("%Y-%m-%dT%H:%M:%S"))
    assert (row.expires_at - row.updated_at).total_seconds() == pytest.approx(45, abs=1)
    _put(world.owner, _sid(), board(world))
    roster = _put(world.sam, sid, at_task(task)).json()["roster"]
    assert roster["projectId"] == str(world.project.pk)
    locations = {(loc["location"]["kind"], loc["location"]["id"]): loc["people"] for loc in roster["locations"]}
    assert set(locations) == {("task", str(task.pk)), ("board", str(world.project.pk))}
    (sam,) = locations[("task", str(task.pk))]
    assert sam["user"] == {"id": str(world.sam.pk), "name": world.sam.name, "hue": world.sam.hue, "avatarUrl": None}
    assert (sam["state"], sam["field"], sam["typing"]) == ("viewing", None, False)
    assert PresenceSession.objects.filter(user=world.sam).count() == 1  # the same tab, updated


@pytest.mark.parametrize(
    ("body", "errors"),
    [
        ({}, {"location.kind": "Pick board, dashboard or task", "location.id": "Pick a location"}),
        ({"location": {"kind": "wall", "id": "x"}}, {"location.kind": "Pick board, dashboard or task"}),
        ({"location": {"kind": "board", "id": ""}}, {"location.id": "Pick a location"}),
        ({"location": {"kind": "board", "id": "P"}, "state": "away"}, {"state": "Pick viewing or editing"}),
        ({"location": {"kind": "board", "id": "P"}, "state": "editing"}, {"field": "Name the field being edited"}),
        ({"location": {"kind": "board", "id": "P"}, "field": "dueDate"}, {"field": "Unknown field"}),
        ({"location": {"kind": "board", "id": "P"}, "state": "editing", "field": "1bad"}, {"field": "Unknown field"}),
        (
            {"location": {"kind": "board", "id": "P"}, "state": "editing", "field": "dueDate", "typing": True},
            {"typing": "Typing needs the comment or description field"},
        ),
    ],
)
def test_validation_messages(world, body, errors):
    if body.get("location", {}).get("id") == "P":
        body["location"]["id"] = str(world.project.pk)
    res = _put(world.sam, _sid(), body)
    assert res.status_code == 422
    assert res.json()["details"]["fields"] == errors


@pytest.mark.parametrize(
    "field", ["cf.0b9e6a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "layout", "comment", "timeEstimateMinutes"]
)
def test_field_names(world, field):
    assert _put(world.sam, _sid(), board(world, state="editing", field=field)).status_code == 200


def test_location_visibility(world, ws):
    from apps.common.testing import make_project

    hidden = make_project(ws, world.owner, key="SEC", name="Secret")
    other_task = create_task(world.owner, hidden, {"title": "Hidden"})
    deleted = create_task(world.owner, world.project, {"title": "Gone"})
    client_for(world.owner).delete(f"/api/v1/tasks/{deleted.pk}")
    assert _put(world.sam, _sid(), at_task(other_task)).json()["code"] == "project_membership_required"
    assert _put(world.sam, _sid(), at_task(deleted)).status_code == 404
    assert _put(world.sam, _sid(), {"location": {"kind": "task", "id": "nope"}}).status_code == 404
    assert _put(world.sam, _sid(), {"location": {"kind": "board", "id": str(uuid.uuid4())}}).status_code == 404
    assert _put(world.sam, _sid(), {"location": {"kind": "board", "id": str(hidden.pk)}}).status_code == 403
    outsider = add_member(ws, UserFactory(), "member")
    assert _put(outsider, _sid(), board(world)).status_code == 403
    stranger = UserFactory()
    assert _put(stranger, _sid(), board(world)).status_code == 404  # not in the workspace


def test_personal_dashboards_are_private(world, listen):
    mine = Dashboard.objects.create(project=world.project, owner=world.sam, name="Mine", visibility="personal")
    shared = Dashboard.objects.create(project=world.project, owner=world.sam, name="Team", visibility="shared")
    listen()
    personal_loc = {"location": {"kind": "dashboard", "id": str(mine.pk)}, "state": "viewing"}
    assert _put(world.owner, _sid(), personal_loc).status_code == 404  # someone else's personal dashboard
    res = _put(world.sam, _sid(), personal_loc)
    assert res.status_code == 200 and res.json()["roster"]["locations"] == []
    assert PresenceSession.objects.get(user=world.sam).private
    assert listen() == []  # never broadcast
    res = _put(world.viewer, _sid(), {"location": {"kind": "dashboard", "id": str(shared.pk)}, "state": "viewing"})
    assert [loc["location"]["kind"] for loc in res.json()["roster"]["locations"]] == ["dashboard"]


def test_roster_aggregates_per_user(world, task):
    t0 = timezone.now()
    with freeze_time(t0):
        _put(world.sam, _sid(), at_task(task))
    with freeze_time(t0 + dt.timedelta(seconds=5)):
        _put(world.viewer, _sid(), at_task(task))
    with freeze_time(t0 + dt.timedelta(seconds=10)):
        _put(world.sam, _sid(), at_task(task, state="editing", field="description", typing=True))  # second tab
    with freeze_time(t0 + dt.timedelta(seconds=12)):
        roster = client_for(world.owner).get(f"/api/v1/workspaces/{SLUG}/presence?filter[project]={world.project.pk}")
    (loc,) = roster.json()["locations"]
    people = loc["people"]
    assert [p["user"]["id"] for p in people] == [str(world.viewer.pk), str(world.sam.pk)]  # sam's editing row is later
    sam = people[1]
    assert (sam["state"], sam["field"], sam["typing"]) == ("editing", "description", True)
    with freeze_time(t0 + dt.timedelta(seconds=19)):  # typing lives 8 s
        roster = client_for(world.owner).get(f"/api/v1/workspaces/{SLUG}/presence?filter[project]={world.project.pk}")
    assert roster.json()["locations"][0]["people"][1]["typing"] is False


def test_since_survives_refreshes_and_resets_on_a_new_state(world, task):
    sid = _sid()
    t0 = timezone.now()
    with freeze_time(t0):
        _put(world.sam, sid, at_task(task))
    with freeze_time(t0 + dt.timedelta(seconds=20)):
        _put(world.sam, sid, at_task(task))
    assert PresenceSession.objects.get(session_id=sid).since == t0
    with freeze_time(t0 + dt.timedelta(seconds=30)):
        _put(world.sam, sid, at_task(task, state="editing", field="title"))
    assert PresenceSession.objects.get(session_id=sid).since == t0 + dt.timedelta(seconds=30)


def test_expired_rows_are_excluded_then_swept(world, task, listen):
    t0 = timezone.now()
    with freeze_time(t0):
        _put(world.sam, _sid(), at_task(task))
        _put(world.viewer, _sid(), board(world))
    listen()
    with freeze_time(t0 + dt.timedelta(seconds=46)):
        roster = client_for(world.owner).get(f"/api/v1/workspaces/{SLUG}/presence?filter[project]={world.project.pk}")
        assert roster.json()["locations"] == []
        assert sweep_presence() == 2
    assert not PresenceSession.objects.exists()
    events = listen()
    assert sorted(e["data"]["location"]["kind"] for e in events) == ["board", "task"]
    assert all(e["type"] == "presence.updated" and e["data"]["people"] == [] and "id" not in e for e in events)
    assert sweep_presence() == 0


def test_publishes_only_on_change(world, task, listen):
    sid = _sid()
    listen()
    _put(world.sam, sid, at_task(task))
    (first,) = listen()
    assert first["type"] == "presence.updated" and first["actorId"] == str(world.sam.pk)
    assert first["data"]["location"] == {"kind": "task", "id": str(task.pk)}
    assert [p["user"]["id"] for p in first["data"]["people"]] == [str(world.sam.pk)]
    _put(world.sam, sid, at_task(task))  # a pure refresh
    assert listen() == []
    _put(world.sam, sid, at_task(task, state="editing", field="dueDate"))
    assert len(listen()) == 1
    _put(world.sam, sid, board(world))  # moved: the old location and the new one
    moved = listen()
    assert [e["data"]["location"]["kind"] for e in moved] == ["task", "board"]
    assert moved[0]["data"]["people"] == []


def test_an_expired_session_coming_back_is_a_change(world, listen):
    sid = _sid()
    t0 = timezone.now()
    with freeze_time(t0):
        _put(world.sam, sid, board(world))
    listen()
    with freeze_time(t0 + dt.timedelta(seconds=60)):
        _put(world.sam, sid, board(world))
    assert len(listen()) == 1


# ── P2, P3 ──


def test_leave_is_idempotent_and_publishes(world, listen):
    sid = _sid()
    _put(world.sam, sid, board(world))
    listen()
    url = f"/api/v1/workspaces/{SLUG}/presence/{sid}"
    assert client_for(world.sam).delete(url).status_code == 204
    (event,) = listen()
    assert event["data"]["people"] == []
    assert client_for(world.sam).delete(url).status_code == 204
    assert listen() == []
    assert client_for(world.sam).delete(f"/api/v1/workspaces/{SLUG}/presence/not-a-uuid").status_code == 404


def test_a_user_can_never_touch_another_users_session(world):
    sid = _sid()
    _put(world.sam, sid, board(world))
    client_for(world.viewer).delete(f"/api/v1/workspaces/{SLUG}/presence/{sid}")
    _put(world.viewer, sid, board(world))
    assert PresenceSession.objects.filter(session_id=sid).count() == 2


def test_roster_needs_a_visible_project(world, ws):
    from apps.common.testing import make_project

    owner = client_for(world.owner)
    res = owner.get(f"/api/v1/workspaces/{SLUG}/presence")
    assert res.status_code == 422 and res.json()["details"]["fields"] == {"filter[project]": "Pick a project"}
    assert owner.get(f"/api/v1/workspaces/{SLUG}/presence?filter[project]={uuid.uuid4()}").status_code == 404
    assert owner.get(f"/api/v1/workspaces/{SLUG}/presence?filter[project]=nope").status_code == 404
    hidden = make_project(ws, world.owner, key="SEC", name="Secret")
    res = client_for(world.sam).get(f"/api/v1/workspaces/{SLUG}/presence?filter[project]={hidden.pk}")
    assert res.status_code == 403
    from apps.common.testing import make_workspace

    elsewhere = make_project(make_workspace(world.owner, slug="other"), world.owner, key="ELS")
    assert owner.get(f"/api/v1/workspaces/{SLUG}/presence?filter[project]={elsewhere.pk}").status_code == 404


def test_presence_throttle_scope(world, monkeypatch):
    from apps.common.throttles import PresenceThrottle

    monkeypatch.setattr(PresenceThrottle, "THROTTLE_RATES", {"presence": "2/min"})
    sid = _sid()
    assert _put(world.sam, sid, board(world)).status_code == 200
    assert _put(world.sam, sid, board(world)).status_code == 200
    res = _put(world.sam, sid, board(world))
    assert res.status_code == 429 and "Retry-After" in res
