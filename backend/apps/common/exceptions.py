"""One error shape for every response: { code, message, details }."""

from __future__ import annotations

import logging
from typing import Any

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.http import Http404
from rest_framework import exceptions as drf
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_default_handler

from .middleware import current_request_id

logger = logging.getLogger("lightex.api")


class ApiError(drf.APIException):
    """Raise from services and views to return a specific status/code/message."""

    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None):
        self.status_code = status
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(detail=message, code=code)


def not_found(message: str = "Not found.", details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(404, "not_found", message, details)


def forbidden(
    message: str = "You don’t have permission to do that.", details: dict[str, Any] | None = None
) -> ApiError:
    return ApiError(403, "forbidden", message, details)


def conflict(code: str, message: str, details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(409, code, message, details)


def invalid(fields: dict[str, str], message: str = "Some fields need fixing.") -> ApiError:
    return ApiError(422, "validation_failed", message, {"fields": fields})


def _flatten(errors: Any, prefix: str = "") -> dict[str, str]:
    """DRF error trees → {"field": "first message"} with dotted paths for nesting."""
    out: dict[str, str] = {}
    if isinstance(errors, dict):
        for key, value in errors.items():
            name = "non_field" if key in ("non_field_errors", "__all__") else str(key)
            out.update(_flatten(value, f"{prefix}{name}" if not prefix else f"{prefix}.{name}"))
    elif isinstance(errors, list):
        if errors and all(not isinstance(e, dict | list) for e in errors):
            out[prefix or "non_field"] = str(errors[0])
        else:
            for i, value in enumerate(errors):
                out.update(_flatten(value, f"{prefix}.{i}" if prefix else str(i)))
    else:
        out[prefix or "non_field"] = str(errors)
    return out


def _body(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"code": code, "message": message, "details": details or {}}


def api_exception_handler(exc: Exception, context: dict[str, Any]) -> Response:
    if isinstance(exc, ApiError):
        return Response(_body(exc.code, exc.message, exc.details), status=exc.status_code)
    if isinstance(exc, drf.ValidationError):
        fields = _flatten(exc.detail)
        return Response(_body("validation_failed", "Some fields need fixing.", {"fields": fields}), status=422)
    if isinstance(exc, drf.NotAuthenticated | drf.AuthenticationFailed):
        response = drf_default_handler(exc, context)
        headers = dict(response.items()) if response is not None else {}
        return Response(_body("unauthorized", "Your session has expired. Sign in again."), status=401, headers=headers)
    if isinstance(exc, drf.PermissionDenied | DjangoPermissionDenied):
        return Response(_body("forbidden", "You don’t have permission to do that."), status=403)
    if isinstance(exc, drf.NotFound | Http404):
        return Response(_body("not_found", "Not found."), status=404)
    if isinstance(exc, drf.Throttled):
        wait = int(getattr(exc, "wait", None) or 1)
        return Response(
            _body("rate_limited", "Too many requests. Try again shortly.", {"retryAfter": wait}),
            status=429,
            headers={"Retry-After": str(wait)},
        )
    if isinstance(exc, drf.MethodNotAllowed):
        return Response(_body("method_not_allowed", "Method not allowed."), status=405)
    if isinstance(exc, drf.UnsupportedMediaType):
        return Response(_body("unsupported_media_type", "Send JSON."), status=415)
    if isinstance(exc, drf.ParseError):
        return Response(_body("bad_request", "The request body could not be parsed."), status=400)
    if isinstance(exc, drf.APIException):
        return Response(_body(str(exc.get_codes()), str(exc.detail)), status=exc.status_code)
    logger.exception("Unhandled API error (request %s)", current_request_id())
    return Response(
        _body("server_error", "Something went wrong on our side.", {"ref": current_request_id()}),
        status=500,
    )
