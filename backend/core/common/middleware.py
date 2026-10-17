"""Request id: accepted from X-Request-ID (if sane) or generated; echoed back and kept for audit rows."""

import contextvars
import re
import uuid

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
_SAFE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")


def current_request_id() -> str | None:
    return _request_id.get()


class RequestIdMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        incoming = request.headers.get("X-Request-ID", "")
        rid = incoming if _SAFE.match(incoming) else f"req_{uuid.uuid4().hex[:16]}"
        token = _request_id.set(rid)
        request.request_id = rid
        try:
            response = self.get_response(request)
        finally:
            _request_id.reset(token)
        response["X-Request-ID"] = rid
        return response
