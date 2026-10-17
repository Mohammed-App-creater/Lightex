"""Core's channel fixtures, with `sam` as a member of the PRJ project (task notifications need one)."""

import pytest

from core.channels.tests.conftest import *  # noqa: F403 - re-exports core's channel fixtures and helpers
from core.channels.tests.conftest import _channels, client_for  # noqa: F401 - _channels is autouse
from modules.tracking.testing import add_project_member, make_project


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", name="Platform Rebuild")


@pytest.fixture
def sam(project):
    from core.accounts.models import User

    user = add_project_member(project, key="project_member")
    User.objects.filter(pk=user.pk).update(name="Sam Rivera")
    user.refresh_from_db()
    return user


@pytest.fixture
def sam_client(sam):
    return client_for(sam)
