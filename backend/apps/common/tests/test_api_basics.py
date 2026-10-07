import pytest
from rest_framework import exceptions as drf
from rest_framework import serializers

from apps.common.exceptions import ApiError, _flatten, api_exception_handler
from apps.common.pagination import decode_cursor, encode_cursor, paginate_list, parse_limit


@pytest.mark.django_db
def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "db": "ok"}
    assert res["X-Request-ID"].startswith("req_")


@pytest.mark.django_db
def test_request_id_is_echoed_when_safe(client):
    res = client.get("/health", HTTP_X_REQUEST_ID="abc12345-trace")
    assert res["X-Request-ID"] == "abc12345-trace"
    res = client.get("/health", HTTP_X_REQUEST_ID="<script>")
    assert res["X-Request-ID"] != "<script>"


@pytest.mark.django_db
def test_unknown_route_is_404(client):
    assert client.get("/api/v1/does-not-exist").status_code == 404


def test_validation_error_is_422_with_flat_fields():
    class S(serializers.Serializer):
        name = serializers.CharField()
        items = serializers.ListField(child=serializers.IntegerField())

    s = S(data={"items": ["x"]})
    assert not s.is_valid()
    res = api_exception_handler(serializers.ValidationError(s.errors), {})
    assert res.status_code == 422
    assert res.data["code"] == "validation_failed"
    assert set(res.data["details"]["fields"]) == {"name", "items.0"}


def test_flatten_shapes():
    assert _flatten({"non_field_errors": ["bad"]}) == {"non_field": "bad"}
    assert _flatten("oops") == {"non_field": "oops"}
    assert _flatten({"a": {"b": ["x"]}}) == {"a.b": "x"}


def test_api_error_and_unknown_errors():
    res = api_exception_handler(ApiError(409, "version_conflict", "Changed", {"current": 1}), {})
    assert res.status_code == 409
    assert res.data == {"code": "version_conflict", "message": "Changed", "details": {"current": 1}}
    res = api_exception_handler(RuntimeError("boom"), {})
    assert res.status_code == 500
    assert res.data["code"] == "server_error"


def test_other_drf_errors():
    assert api_exception_handler(drf.Throttled(wait=3), {}).status_code == 429
    assert api_exception_handler(drf.MethodNotAllowed("PUT"), {}).status_code == 405
    assert api_exception_handler(drf.ParseError(), {}).status_code == 400
    assert api_exception_handler(drf.UnsupportedMediaType("text/plain"), {}).status_code == 415
    assert api_exception_handler(drf.PermissionDenied(), {}).data["code"] == "forbidden"
    assert api_exception_handler(drf.NotFound(), {}).data["code"] == "not_found"
    assert api_exception_handler(drf.NotAuthenticated(), {}).data["code"] == "unauthorized"


def test_cursor_roundtrip_and_tamper():
    token = encode_cursor(["2026-01-01", 5])
    assert decode_cursor(token, 2) == ["2026-01-01", 5]
    with pytest.raises(ApiError):
        decode_cursor(token, 3)
    with pytest.raises(ApiError):
        decode_cursor("!!!notbase64", 1)


def test_parse_limit_and_list_paging():
    assert parse_limit("x", 10, 50) == 10
    assert parse_limit("500", 10, 50) == 50
    assert parse_limit("0", 10, 50) == 1
    page = paginate_list(list(range(5)), {"limit": "2"})
    assert page["data"] == [0, 1]
    assert page["nextCursor"]
    page2 = paginate_list(list(range(5)), {"limit": "2", "cursor": page["nextCursor"]})
    assert page2["data"] == [2, 3]
