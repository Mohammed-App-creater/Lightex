"""Sales S0 §2: the workspace timezone, its API and the local-date helpers."""

import datetime as dt

import pytest

from core.audit.models import AuditLog
from core.common.testing import add_member, client_for, make_workspace
from core.workspaces.models import Workspace
from core.workspaces.timezone import (
    DEFAULT_TIMEZONE,
    day_bounds,
    is_valid_timezone,
    local_date,
    range_bounds,
    workspace_now,
    workspace_today,
    workspace_zone,
)

pytestmark = pytest.mark.django_db

URL = "/api/v1/workspaces/platform"
UTC = dt.UTC


def at(*args):
    return dt.datetime(*args, tzinfo=UTC)


def test_default_and_response(owner, ws):
    assert ws.timezone == DEFAULT_TIMEZONE == "Africa/Addis_Ababa"
    assert client_for(owner).get(URL).json()["timezone"] == "Africa/Addis_Ababa"
    listed = client_for(owner).get("/api/v1/workspaces").json()
    assert listed[0]["timezone"] == "Africa/Addis_Ababa"


def test_update_validates_and_audits(owner, ws):
    client = client_for(owner)
    for bad in ("Mars/Olympus", "", None, 5, "africa/addis_ababa"):
        res = client.patch(URL, {"timezone": bad}, format="json")
        assert res.status_code == 422, bad
        assert res.json()["details"]["fields"] == {"timezone": "Pick a valid time zone"}
    ok = client.patch(URL, {"timezone": "Europe/Berlin"}, format="json")
    assert ok.status_code == 200
    assert ok.json()["timezone"] == "Europe/Berlin"
    assert Workspace.objects.get(pk=ws.pk).timezone == "Europe/Berlin"
    row = AuditLog.objects.filter(action="core.workspace.updated").latest("created_at")
    assert row.changes == [
        {"field": "Time zone", "kind": "value", "before": "Africa/Addis_Ababa", "after": "Europe/Berlin"}
    ]


def test_update_needs_workspace_update(ws):
    member = add_member(ws)
    res = client_for(member).patch(URL, {"timezone": "Europe/Berlin"}, format="json")
    assert res.status_code == 403


def test_today_around_midnight(owner, ws):
    """Addis Ababa is UTC+3 all year: 20:59 UTC is still the same day there, 21:00 UTC is the next."""
    assert workspace_today(ws, at(2026, 10, 17, 20, 59)) == dt.date(2026, 10, 17)
    assert workspace_today(ws, at(2026, 10, 17, 21, 0)) == dt.date(2026, 10, 18)
    assert workspace_now(ws, at(2026, 10, 17, 21, 30)).isoformat() == "2026-10-18T00:30:00+03:00"
    # A deal won at 23:30 and one at 00:30 workspace time land on different days.
    assert local_date(ws, at(2026, 10, 17, 20, 30)) == dt.date(2026, 10, 17)
    assert local_date(ws, at(2026, 10, 17, 21, 30)) == dt.date(2026, 10, 18)
    la = make_workspace(owner, name="West", slug="west")
    la.timezone = "America/Los_Angeles"
    assert workspace_today(la, at(2026, 10, 18, 6, 59)) == dt.date(2026, 10, 17)
    assert workspace_today(la, at(2026, 10, 18, 7, 0)) == dt.date(2026, 10, 18)
    assert workspace_today(ws).isoformat()  # the current instant works too


def test_bounds(ws):
    start, end = day_bounds(ws, dt.date(2026, 10, 17))
    assert (start, end) == (at(2026, 10, 16, 21), at(2026, 10, 17, 21))
    first, last = range_bounds(ws, dt.date(2026, 10, 1), dt.date(2026, 10, 31))
    assert (first, last) == (at(2026, 9, 30, 21), at(2026, 10, 31, 21))


def test_bounds_across_a_dst_change(ws):
    ws.timezone = "Europe/Berlin"  # 2026-10-25: clocks go back, the day has 25 hours
    start, end = day_bounds(ws, dt.date(2026, 10, 25))
    assert (start, end) == (at(2026, 10, 24, 22), at(2026, 10, 25, 23))


def test_helpers_fall_back_on_a_bad_stored_name(ws):
    ws.timezone = "Nowhere/Land"
    assert str(workspace_zone(ws)) == DEFAULT_TIMEZONE
    assert is_valid_timezone("UTC")
    assert not is_valid_timezone(None)
