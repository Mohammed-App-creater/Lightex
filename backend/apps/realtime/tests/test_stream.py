"""The SSE stream (docs/v2/33-dashboards-presence.md §2.3–§2.7, §8.1 "Stream view").

Test settings: the in-process `local` broker, a 0.05 s heartbeat and a 0.5 s lifetime without jitter. The stream's
generator runs in the test's thread on each `next()`, so every test is deterministic and bounded.
"""

import datetime as dt
import gc
import time

import pytest
from django.db import connection
from django.test import override_settings
from freezegun import freeze_time
from rest_framework_simplejwt.tokens import AccessToken

from apps.common.testing import UserFactory, add_member, client_for, make_workspace
from apps.realtime.hub import hub
from apps.realtime.models import RealtimeEvent
from apps.realtime.services import publish, purge_events

from .conftest import Stream, close_response, open_stream

pytestmark = pytest.mark.django_db


def _task_event(project, n=1, actor=None):
    for i in range(n):
        publish(
            "task.changed",
            workspace=project.workspace_id,
            project=project.pk,
            actor=actor,
            data={"taskId": f"t{i}", "key": f"PRJ-{i}", "op": "updated", "version": i, "fields": []},
        )


def _last_id():
    return RealtimeEvent.objects.order_by("-id").values_list("id", flat=True).first()


# ── errors before the stream ──


def test_needs_the_event_stream_accept_header(world):
    res = client_for(world.sam).get("/api/v1/workspaces/platform/stream")
    assert res.status_code == 406
    assert res.json()["code"] == "not_acceptable"
    assert res["Content-Type"].startswith("application/json")


def test_anonymous_is_401_and_non_members_404(world):
    assert open_stream(None).status_code == 401
    outsider = UserFactory()
    make_workspace(outsider, slug="elsewhere")
    res = open_stream(outsider)
    assert res.status_code == 404
    assert res["Content-Type"].startswith("application/json")


def test_unknown_protocol_version_is_400(world):
    res = open_stream(world.sam, query="?v=2")
    assert res.status_code == 400
    assert res.json()["code"] == "unsupported_version"
    assert res.json()["details"] == {"supported": [1]}
    assert open_stream(world.sam, query="?v=1").status_code == 200


@override_settings(REALTIME_ENABLED=False)
def test_kill_switch_answers_503_and_publishes_nothing(world):
    res = open_stream(world.sam)
    assert res.status_code == 503
    assert res.json()["code"] == "realtime_unavailable"
    assert res["Retry-After"] == "300"
    before = RealtimeEvent.objects.count()
    _task_event(world.project)
    assert RealtimeEvent.objects.count() == before


def test_per_process_cap(world):
    with override_settings(SSE_MAX_STREAMS_PER_PROCESS=1):
        first = open_stream(world.sam)
        assert first.status_code == 200
        busy = open_stream(world.owner)
        assert busy.status_code == 503
        assert busy.json()["code"] == "realtime_busy"
        assert busy["Retry-After"] == "60"
        close_response(first)  # the server closes the response when the client goes away
        assert hub.active_streams == 0
        again = open_stream(world.owner)
        assert again.status_code == 200
        Stream(again).rest()  # a stream that ran to its end releases its slot too
        assert hub.active_streams == 0


def test_an_unread_response_releases_its_slot_when_dropped(world):
    with override_settings(SSE_MAX_STREAMS_PER_PROCESS=1):
        res = open_stream(world.sam)
        assert hub.active_streams == 1
        del res
        gc.collect()
        assert hub.active_streams == 0


def test_stream_scope_throttle(world, monkeypatch):
    from apps.common.throttles import StreamThrottle

    monkeypatch.setattr(StreamThrottle, "THROTTLE_RATES", {"stream": "2/min"})
    for _ in range(2):
        close_response(open_stream(world.sam))
    res = open_stream(world.sam)
    assert res.status_code == 429
    assert "Retry-After" in res


# ── the stream ──


def test_headers_retry_and_hello(world):
    res = open_stream(world.sam)
    assert res.status_code == 200
    assert res["Content-Type"] == "text/event-stream; charset=utf-8"
    assert res["Cache-Control"] == "no-cache, no-transform"
    assert res["X-Accel-Buffering"] == "no"
    stream = Stream(res)
    retry, hello = stream.next()
    assert retry == {"retry": "3000"}
    assert hello["event"] == "hello" and "id" not in hello
    data = hello["data"]
    assert data["v"] == 1 and data["type"] == "hello"
    assert data["data"]["projects"] == [str(world.project.pk)]  # visible projects only (not OPS)
    assert data["data"]["replayed"] == 0
    assert data["data"]["heartbeatSec"] == 0.05 and data["data"]["maxLifetimeSec"] == 0.5
    assert data["data"]["connectionId"].startswith("c_")
    stream.close()


def test_owner_sees_every_project_including_archived(world):
    client_for(world.owner).post(f"/api/v1/projects/{world.other.pk}/archive")
    stream = Stream(open_stream(world.owner))
    hello = stream.next()[1]["data"]["data"]
    assert sorted(hello["projects"]) == sorted([str(world.project.pk), str(world.other.pk)])
    stream.close()


def test_heartbeat_comment_after_silence(world):
    stream = Stream(open_stream(world.sam))
    stream.next()
    (ping,) = stream.next()
    assert ping["comment"].startswith("ping 20")
    stream.close()


def test_live_events_are_filtered_per_connection(world):
    stream = Stream(open_stream(world.sam))
    stream.next()
    _task_event(world.other)  # sam isn't on OPS
    publish("inbox.changed", workspace=world.ws, user=world.owner, data={"unread": 3})  # someone else's
    publish("inbox.changed", workspace=world.ws, user=world.sam, data={"unread": 1})
    _task_event(world.project)
    first = stream.next_event()
    second = stream.next_event()
    assert [m["event"] for m in first + second] == ["inbox.changed", "task.changed"]
    inbox = first[0]["data"]
    assert inbox["data"] == {"unread": 1} and "userId" not in inbox
    task = second[0]
    assert task["id"] == task["data"]["id"] == str(_last_id())
    assert task["data"]["projectId"] == str(world.project.pk) and task["data"]["ws"] == str(world.ws.pk)
    stream.close()


def test_volatile_events_have_no_id(world):
    stream = Stream(open_stream(world.sam))
    stream.next()
    publish(
        "presence.updated",
        workspace=world.ws,
        project=world.project,
        durable=False,
        data={"location": {"kind": "board", "id": str(world.project.pk)}, "people": [], "at": "x"},
    )
    (msg,) = stream.next_event()
    assert msg["event"] == "presence.updated" and "id" not in msg and "id" not in msg["data"]
    assert not RealtimeEvent.objects.exists()
    stream.close()


def test_ends_with_reconnect_after_its_lifetime(world):
    started = time.monotonic()
    msgs = Stream(open_stream(world.sam)).rest()
    assert time.monotonic() - started < 5
    assert msgs[-1]["event"] == "reconnect"
    assert msgs[-1]["data"]["data"] == {"reason": "lifetime", "retryMs": 500}
    assert any("comment" in m for m in msgs)  # pings while idle
    assert hub.active_streams == 0 and hub.subscriptions() == []


def test_never_outlives_its_token(world):
    token = AccessToken.for_user(world.sam)
    token.set_exp(lifetime=dt.timedelta(seconds=20))  # less than the 30 s margin
    client = client_for(None)
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    msgs = Stream(open_stream(None, client=client)).rest()
    assert [m.get("event") for m in msgs if "comment" not in m][-1] == "reconnect"
    assert msgs[-1]["data"]["data"]["reason"] == "token_expiry"


def test_a_long_lived_token_is_not_cut_short(world):
    token = AccessToken.for_user(world.sam)
    token.set_exp(lifetime=dt.timedelta(minutes=15))
    client = client_for(None)
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    msgs = Stream(open_stream(None, client=client)).rest()
    assert msgs[-1]["data"]["data"]["reason"] == "lifetime"


def test_access_change_ends_the_stream(world):
    stream = Stream(open_stream(world.sam))
    stream.next()
    manager = world.ws.roles.get(system_key="manager")
    res = client_for(world.owner).patch(
        f"/api/v1/projects/{world.project.pk}/members/{world.sam.pk}", {"roleId": str(manager.pk)}, format="json"
    )
    assert res.status_code == 200, res.content
    msgs = stream.rest()
    events = [m["event"] for m in msgs if "event" in m]
    assert events[-2:] == ["access.changed", "reconnect"]
    assert msgs[-1]["data"]["data"] == {"reason": "access_changed", "retryMs": 500}


def test_overflow_resets_and_reconnects(world):
    with override_settings(SSE_QUEUE_SIZE=2):
        stream = Stream(open_stream(world.sam))
        stream.next()
        _task_event(world.project, n=3)
        msgs = stream.rest()
    assert [m["data"]["type"] for m in msgs] == ["reset", "reconnect"]
    assert msgs[0]["data"]["data"] == {"reason": "slow_consumer"}
    assert msgs[1]["data"]["data"] == {"reason": "lifetime", "retryMs": 1000}


def test_shutdown_ends_every_stream(world):
    stream = Stream(open_stream(world.sam))
    stream.next()
    hub.shutdown()
    msgs = stream.rest()
    assert msgs[-1]["data"]["data"]["reason"] == "shutdown"
    assert 1000 <= msgs[-1]["data"]["data"]["retryMs"] <= 5000
    assert open_stream(world.owner).status_code == 503  # a closing process takes no new streams


@override_settings(SSE_TEST_MAX_EVENTS=1)
def test_max_events_test_hook(world):
    stream = Stream(open_stream(world.sam))
    stream.next()
    _task_event(world.project, n=2)
    assert [m["event"] for m in stream.rest()] == ["task.changed"]


# ── replay ──


def test_replay_after_last_event_id(world):
    _task_event(world.project, n=3)
    _task_event(world.other)  # not visible to sam
    ids = list(RealtimeEvent.objects.order_by("id").values_list("id", flat=True))
    stream = Stream(open_stream(world.sam, last_event_id=ids[0]))
    msgs = stream.next() + stream.next() + stream.next()
    hello = msgs[1]["data"]["data"]
    assert hello["replayed"] == 2
    assert [m["id"] for m in msgs[2:]] == [str(ids[1]), str(ids[2])]
    # live events continue after the replay, without duplicates
    _task_event(world.project)
    (live,) = stream.next_event()
    assert int(live["id"]) == _last_id()
    stream.close()


def test_replay_skips_volatile_and_other_users_events(world):
    publish("inbox.changed", workspace=world.ws, user=world.owner, data={"unread": 2})
    cursor = _last_id()
    publish("inbox.changed", workspace=world.ws, user=world.owner, data={"unread": 3})
    publish("inbox.changed", workspace=world.ws, user=world.sam, data={"unread": 1})
    stream = Stream(open_stream(world.sam, last_event_id=cursor))
    msgs = stream.next() + stream.next()
    assert msgs[1]["data"]["data"]["replayed"] == 1
    assert msgs[2]["event"] == "inbox.changed" and msgs[2]["data"]["data"] == {"unread": 1}
    stream.close()


def test_no_header_means_no_replay(world):
    _task_event(world.project, n=2)
    stream = Stream(open_stream(world.sam))
    hello = stream.next()[1]["data"]["data"]
    assert hello["replayed"] == 0
    assert stream.next()[0].get("comment")  # straight to the live loop
    stream.close()


@pytest.mark.parametrize("cursor", ["abc", "-1", "1e3"])
def test_a_cursor_that_is_not_a_number_resets(world, cursor):
    stream = Stream(open_stream(world.sam, last_event_id=cursor))
    msgs = stream.next() + stream.next()
    assert msgs[2]["data"]["type"] == "reset"
    assert msgs[2]["data"]["data"] == {"reason": "unknown_cursor"}
    stream.close()


def test_a_cursor_older_than_retention_resets(world):
    with freeze_time(dt.datetime.now(dt.UTC) - dt.timedelta(minutes=20)):
        _task_event(world.project, n=2)
    old = RealtimeEvent.objects.order_by("id").values_list("id", flat=True).first()
    _task_event(world.project)
    assert purge_events() == 2
    stream = Stream(open_stream(world.sam, last_event_id=old))
    msgs = stream.next() + stream.next()
    assert msgs[2]["data"]["data"] == {"reason": "unknown_cursor"}
    stream.close()


def test_a_cursor_from_the_future_resets(world):
    _task_event(world.project)
    stream = Stream(open_stream(world.sam, last_event_id=_last_id() + 1000))
    msgs = stream.next() + stream.next()
    assert msgs[2]["data"]["data"] == {"reason": "unknown_cursor"}
    stream.close()


def test_the_newest_cursor_replays_nothing(world):
    _task_event(world.project)
    stream = Stream(open_stream(world.sam, last_event_id=_last_id()))
    assert stream.next()[1]["data"]["data"]["replayed"] == 0
    stream.close()


def test_more_than_the_replay_limit_resets_with_gap_and_stays_live(world):
    _task_event(world.project)
    cursor = _last_id()
    _task_event(world.project, n=4)
    with override_settings(REALTIME_REPLAY_LIMIT=3):
        stream = Stream(open_stream(world.sam, last_event_id=cursor))
        msgs = stream.next() + stream.next()
        assert msgs[1]["data"]["data"]["replayed"] == 0
        assert msgs[2]["data"]["data"] == {"reason": "gap"}
        _task_event(world.project)
        (live,) = stream.next_event()
        assert live["event"] == "task.changed"
    stream.close()


# ── database connection ──


@pytest.mark.django_db(transaction=True)
def test_the_db_connection_is_closed_before_waiting():
    owner = UserFactory()
    ws = make_workspace(owner, slug="platform")
    add_member(ws, UserFactory(), "member")
    stream = Stream(open_stream(owner))
    stream.next()  # retry + hello
    assert connection.connection is not None
    stream.next()  # the prelude ends, the loop pings
    assert connection.connection is None
    stream.close()
