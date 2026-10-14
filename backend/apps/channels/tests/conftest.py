import datetime as dt
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from django.utils import timezone

from apps.channels import crypto
from apps.channels.models import PushSubscription, SmsConnection, TelegramConnection
from apps.channels.providers import get_push, get_sms, get_telegram
from apps.common.testing import add_project_member, client_for, make_project

P256DH = "BD7Xoo7GSO3OXVt-JS9rKq-7RINRFKJLPKqPcQ9kmTvCVxGjTNySKQgLY58Jl3_rfKkezOFkm_6orYXHKyBq3n4"
AUTH = "5I2Bu2oKdyy9CwL8QVF0NQ"
FCM = "https://fcm.googleapis.com/fcm/send/"


@pytest.fixture(autouse=True)
def _channels(settings):
    settings.FRONTEND_URL = "https://app.lightex.dev"
    settings.API_PUBLIC_URL = "https://api.lightex.dev"
    for provider in (get_telegram(), get_sms(), get_push()):
        provider.reset()
    yield
    from apps.channels.providers import base

    for provider in base._instances.values():
        if hasattr(provider, "reset"):
            provider.reset()


@pytest.fixture
def tg():
    return get_telegram()


@pytest.fixture
def sms():
    return get_sms()


@pytest.fixture
def push():
    return get_push()


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", name="Platform Rebuild")


@pytest.fixture
def sam(project):
    from apps.accounts.models import User

    user = add_project_member(project, key="project_member")
    User.objects.filter(pk=user.pk).update(name="Sam Rivera")
    user.refresh_from_db()
    return user


@pytest.fixture
def sam_client(sam):
    return client_for(sam)


def connect_telegram(user, chat_id=4242, status="active", username="sam"):
    return TelegramConnection.objects.create(
        user=user, chat_id=chat_id, username=username, first_name="Sam", status=status, connected_at=timezone.now()
    )


def connect_sms(user, e164="+14155550132", status="active", country="US"):
    return SmsConnection.objects.create(
        user=user,
        phone_enc=crypto.encrypt_phone(e164),
        phone_hash=crypto.phone_hash(e164),
        country=country,
        last4=e164[-4:],
        status=status,
        verified_at=timezone.now(),
    )


def connect_push(user, n=1, status="active", seen=None):
    return PushSubscription.objects.create(
        user=user,
        endpoint=f"{FCM}device-{user.pk}-{n}",
        endpoint_hash=crypto.sha256(f"{FCM}device-{user.pk}-{n}"),
        p256dh=P256DH,
        auth=AUTH,
        label="Chrome on macOS",
        status=status,
        last_seen_at=seen or timezone.now() - dt.timedelta(minutes=n),
    )


class StubServer:
    """A real HTTP server in a thread: scripted responses, recorded requests."""

    def __init__(self):
        self.requests: list[dict] = []
        self.responses: list[tuple[int, dict, bytes]] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                stub.requests.append(
                    {"path": self.path, "headers": dict(self.headers.items()), "body": self.rfile.read(length)}
                )
                status, headers, body = stub.responses.pop(0) if stub.responses else (200, {}, b"{}")
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def reply(self, status=200, body=None, headers=None):
        raw = body if isinstance(body, bytes) else json.dumps(body if body is not None else {}).encode()
        self.responses.append((status, headers or {}, raw))

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def stub():
    server = StubServer()
    yield server
    server.close()
