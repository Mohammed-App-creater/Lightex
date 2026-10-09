import json

import pytest

from apps.common.testing import add_project_member, client_for, make_project


@pytest.fixture(autouse=True)
def _fresh_hub():
    from apps.realtime.hub import hub

    hub.reset()
    yield
    hub.reset()


class World:
    def __init__(self, ws, owner):
        self.ws = ws
        self.owner = owner
        self.project = make_project(ws, owner, key="PRJ")
        self.other = make_project(ws, owner, key="OPS", name="Ops")
        self.sam = add_project_member(self.project, key="project_member")
        self.viewer = add_project_member(self.project, key="viewer")
        from apps.realtime.models import RealtimeEvent

        RealtimeEvent.objects.all().delete()  # the setup's own events


@pytest.fixture
def world(ws, owner):
    return World(ws, owner)


def parse_sse(chunks):
    """bytes chunks → list of messages: {"comment"} | {"retry"} | {"id", "event", "data"}."""
    text = b"".join(chunks).decode()
    out = []
    for block in text.split("\n\n"):
        if not block:
            continue
        msg = {}
        for line in block.split("\n"):
            if line.startswith(":"):
                msg["comment"] = line[1:].strip()
            else:
                key, _, value = line.partition(": ")
                msg[key] = json.loads(value) if key == "data" else value
        out.append(msg)
    return out


class Stream:
    """Reads an SSE response chunk by chunk, in the test's thread (the generator runs on next())."""

    def __init__(self, response):
        self.response = response
        self.it = iter(response.streaming_content)
        self.done = False

    def next(self):
        try:
            return parse_sse([next(self.it)])
        except StopIteration:
            self.done = True
            return []

    def next_event(self, limit=200):
        """The next non-comment messages (skips pings)."""
        for _ in range(limit):
            msgs = [m for m in self.next() if "comment" not in m]
            if msgs or self.done:
                return msgs
        raise AssertionError("no event")

    def rest(self, limit=400):
        out = []
        for _ in range(limit):
            msgs = self.next()
            if self.done:
                return out
            out.extend(msgs)
        raise AssertionError("the stream did not end")

    def close(self):
        close_response(self.response)


def close_response(response):
    """What the server does when the client goes away (without the request_finished connection cleanup, which
    would close the test's transaction)."""
    from django.core.signals import request_finished
    from django.db import close_old_connections

    request_finished.disconnect(close_old_connections)
    try:
        response.close()
    finally:
        request_finished.connect(close_old_connections)


def open_stream(user, slug="platform", *, last_event_id=None, client=None, query=""):
    client = client or client_for(user)
    headers = {"HTTP_ACCEPT": "text/event-stream"}
    if last_event_id is not None:
        headers["HTTP_LAST_EVENT_ID"] = str(last_event_id)
    return client.get(f"/api/v1/workspaces/{slug}/stream{query}", **headers)
