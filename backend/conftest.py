import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.common.testing import UserFactory, client_for, make_workspace


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _run_on_commit_immediately(monkeypatch):
    """Tests run inside one transaction; fire on_commit work (emails, events) right away."""
    from django.db import transaction

    monkeypatch.setattr(transaction, "on_commit", lambda func, using=None, robust=False: func())


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def owner(db):
    return UserFactory(name="Alex Kim", email="alex@team.dev")


@pytest.fixture
def ws(owner):
    return make_workspace(owner, name="Platform team", slug="platform")


@pytest.fixture
def as_user():
    """as_user(user) -> APIClient authenticated as that user."""
    return client_for
