import pytest
from django.utils import timezone

from core.common.testing import client_for
from modules.tracking.integrations import http
from modules.tracking.integrations.models import Integration, Repository
from modules.tracking.integrations.providers.fake import FAKE
from modules.tracking.testing import add_project_member, make_project


@pytest.fixture(autouse=True)
def _fake_reset():
    FAKE.reset()
    yield
    FAKE.reset()
    http.set_transport(None)


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", name="Platform Rebuild")


@pytest.fixture
def owner_client(owner):
    return client_for(owner)


def make_integration(ws, provider="github", **kw):
    defaults = {
        "github": {
            "auth_kind": "github_app",
            "base_url": "https://github.com",
            "account_external_id": "51234567",
            "account_login": "platform-team",
            "account_kind": "organization",
            "account_url": "https://github.com/platform-team",
        },
        "gitlab": {
            "auth_kind": "gitlab_token",
            "base_url": "https://gitlab.com",
            "account_external_id": "9001",
            "account_login": "alexkim",
            "account_kind": "user",
            "account_url": "https://gitlab.com/alexkim",
        },
    }[provider]
    integration = Integration(
        workspace=ws,
        provider=provider,
        status=kw.pop("status", "active"),
        connected_at=timezone.now(),
        last_synced_at=kw.pop("last_synced_at", timezone.now()),
        **{**defaults, **kw},
    )
    if provider == "gitlab":
        integration.set_secret("webhook_secret", "gl-secret")
        integration.set_credentials({"token": "fake-token"})
    integration.save()
    return integration


def track(integration, name="web", external_id=None, **kw):
    ext = external_id or ("712004001" if integration.provider == "github" else "442004001")
    owner = "platform-team"
    return Repository.objects.create(
        integration=integration,
        workspace_id=integration.workspace_id,
        external_id=ext,
        full_path=f"{owner}/{name}",
        owner_path=owner,
        name=name,
        web_url=f"{integration.base_url}/{owner}/{name}",
        **kw,
    )


@pytest.fixture
def github(ws):
    return make_integration(ws, "github")


@pytest.fixture
def web(github):
    return track(github)


@pytest.fixture
def sam(project):
    return add_project_member(project, key="project_member")
