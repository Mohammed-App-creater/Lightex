"""Core's realtime test helpers plus the tracking `World` (two projects, a member and a viewer)."""

import pytest

from core.realtime.tests.conftest import *  # noqa: F403 - re-exports core's stream helpers and fixtures
from core.realtime.tests.conftest import _fresh_hub  # noqa: F401 - autouse fixture (not covered by *)
from modules.tracking.testing import add_project_member, make_project


class World:
    def __init__(self, ws, owner):
        self.ws = ws
        self.owner = owner
        self.project = make_project(ws, owner, key="PRJ")
        self.other = make_project(ws, owner, key="OPS", name="Ops")
        self.sam = add_project_member(self.project, key="project_member")
        self.viewer = add_project_member(self.project, key="viewer")
        from core.realtime.models import RealtimeEvent

        RealtimeEvent.objects.all().delete()  # the setup's own events


@pytest.fixture
def world(ws, owner):
    return World(ws, owner)
