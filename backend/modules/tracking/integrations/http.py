"""Every outbound provider call (docs/v2/37-integrations-github-gitlab.md §2.4, §10.4).

Standard library only (like `accounts/google.py`): 10 s connect / 15 s read timeouts, a 5 MB response cap, no
redirect following, a `User-Agent`, rate-limit headers on the response, and — for self-managed GitLab — the SSRF
guard: `SafeTarget` validates the URL, resolves the host once, vets **every** address, and the connection is opened to
the vetted IP (TLS still verifies the hostname), which defeats DNS rebinding.

Tests replace the network with `set_transport(fn)`; `fn(method, url, headers, body, connect_ip)` returns a
`Response`.
"""

from __future__ import annotations

import fnmatch
import http.client
import ipaddress
import json
import socket
import ssl
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from django.conf import settings

CONNECT_TIMEOUT = 10.0
READ_TIMEOUT = 15.0
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
USER_AGENT = "Lightex-Integrations/1"
_BLOCKED_NETS = [ipaddress.ip_network(n) for n in ("100.64.0.0/10", "169.254.0.0/16", "fd00::/8", "fc00::/7")]


class UnsafeUrl(Exception):
    """The address fails the SSRF rules; `message` is the client copy for `baseUrl`."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class TransportError(Exception):
    """Timeout, connection failure, redirect or oversized response."""


@dataclass
class Response:
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    def json(self) -> Any:
        return json.loads(self.body or b"null")

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())

    @property
    def rate_remaining(self) -> int | None:
        value = self.header("x-ratelimit-remaining") or self.header("ratelimit-remaining")
        return int(value) if value and value.isdigit() else None

    @property
    def rate_reset(self) -> int | None:
        value = self.header("x-ratelimit-reset") or self.header("ratelimit-reset")
        return int(value) if value and value.isdigit() else None


Transport = Callable[[str, str, dict[str, str], bytes | None, str | None], Response]


# ───────────────────────── SSRF guard (§10.4) ─────────────────────────


def _vet_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%")[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if not ip.is_global or ip.is_multicast or ip.is_reserved:
        return False
    return not any(ip in net for net in _BLOCKED_NETS if net.version == ip.version)


def _host_allowed(host: str) -> bool:
    patterns = [p.strip().lower() for p in settings.GITLAB_ALLOWED_HOSTS if p.strip()]
    return not patterns or any(fnmatch.fnmatch(host, p) for p in patterns)


class SafeTarget:
    """A vetted self-managed GitLab origin. `origin` is the normalised base URL (no path, no trailing slash)."""

    def __init__(self, base_url: str):
        allow_private = settings.GITLAB_ALLOW_PRIVATE_NETWORKS
        parts = urllib.parse.urlsplit((base_url or "").strip())
        if parts.scheme != "https" and not (parts.scheme == "http" and allow_private):
            raise UnsafeUrl("Use an https:// address.")
        if parts.username or parts.password or "@" in parts.netloc:
            raise UnsafeUrl("This address isn't allowed.")
        try:
            raw_host = parts.hostname or ""
            port = parts.port
        except ValueError as exc:
            raise UnsafeUrl("This address isn't allowed.") from exc
        if not raw_host:
            raise UnsafeUrl("Use an https:// address.")
        try:
            host = raw_host.encode("idna").decode().lower() if not _is_ip(raw_host) else raw_host.lower()
        except UnicodeError as exc:
            raise UnsafeUrl("This address isn't allowed.") from exc
        default_port = 443 if parts.scheme == "https" else 80
        if port is not None and port != default_port and not (1024 <= port <= 65535):
            raise UnsafeUrl("This address isn't allowed.")
        if not _host_allowed(host):
            raise UnsafeUrl("This address isn't allowed.")
        self.scheme = parts.scheme
        self.host = host
        self.port = port or default_port
        netloc = f"[{host}]" if ":" in host else host
        self.origin = f"{parts.scheme}://{netloc}" + (f":{port}" if port and port != default_port else "")
        self._ip: str | None = None

    def resolve(self) -> str:
        """Resolves once and vets every answer; the connection then uses this IP."""
        if self._ip is not None:
            return self._ip
        try:
            infos = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise UnsafeUrl("Couldn't reach GitLab at this address.") from exc
        addresses = [str(info[4][0]) for info in infos]
        if not addresses:
            raise UnsafeUrl("Couldn't reach GitLab at this address.")
        if not settings.GITLAB_ALLOW_PRIVATE_NETWORKS and not all(_vet_ip(a) for a in addresses):
            raise UnsafeUrl("This address isn't allowed.")
        self._ip = addresses[0]
        return self._ip


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def normalize_base_url(value: str) -> str:
    """The normalised origin of a self-managed GitLab URL (raises UnsafeUrl). Does not resolve."""
    return SafeTarget(value).origin


# ───────────────────────── transport ─────────────────────────


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connects to a vetted IP but verifies the certificate against the hostname."""

    def __init__(self, host: str, port: int, ip: str):
        super().__init__(host, port, timeout=CONNECT_TIMEOUT, context=ssl.create_default_context())
        self._ip = ip

    def connect(self) -> None:
        sock = socket.create_connection((self._ip, self.port), timeout=CONNECT_TIMEOUT)
        sock.settimeout(READ_TIMEOUT)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)  # type: ignore[attr-defined]


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, ip: str):
        super().__init__(host, port, timeout=CONNECT_TIMEOUT)
        self._ip = ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._ip, self.port), timeout=CONNECT_TIMEOUT)
        self.sock.settimeout(READ_TIMEOUT)


def _stdlib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None, ip: str | None) -> Response:
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    conn: http.client.HTTPConnection
    if ip is not None:
        conn = (_PinnedHTTPSConnection if parts.scheme == "https" else _PinnedHTTPConnection)(host, port, ip)
    elif parts.scheme == "https":
        conn = http.client.HTTPSConnection(host, port, timeout=READ_TIMEOUT, context=ssl.create_default_context())
    else:  # pragma: no cover - only https hosts are called without a SafeTarget
        raise TransportError("plain http is only allowed through a SafeTarget")
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    try:
        conn.request(method, path, body=body, headers=headers)
        res = conn.getresponse()
        data = res.read(MAX_RESPONSE_BYTES + 1)
        return Response(res.status, {k.lower(): v for k, v in res.getheaders()}, data)
    except (OSError, http.client.HTTPException) as exc:
        raise TransportError(str(exc)) from exc
    finally:
        conn.close()


_transport: Transport = _stdlib_transport


def set_transport(fn: Transport | None) -> None:
    """Tests: replace the network (None restores the real one)."""
    global _transport
    _transport = fn or _stdlib_transport


def request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    json_body: Any = None,
    form: dict[str, str] | None = None,
    target: SafeTarget | None = None,
) -> Response:
    all_headers = {"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})}
    body: bytes | None = None
    if json_body is not None:
        body = json.dumps(json_body).encode()
        all_headers["Content-Type"] = "application/json"
    elif form is not None:
        body = urllib.parse.urlencode(form).encode()
        all_headers["Content-Type"] = "application/x-www-form-urlencoded"
    ip = target.resolve() if target is not None else None
    res = _transport(method, url, all_headers, body, ip)
    if 300 <= res.status < 400:
        raise TransportError(f"unexpected redirect ({res.status})")
    if len(res.body) > MAX_RESPONSE_BYTES:
        raise TransportError("response too large")
    return res
