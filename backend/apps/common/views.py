from django.db import connection
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import api_view, authentication_classes, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


@extend_schema(
    tags=["health"],
    responses=inline_serializer("Health", {"status": serializers.CharField(), "db": serializers.CharField()}),
)
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([])
def health(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        db = "ok"
    except Exception:
        db = "unavailable"
    return Response({"status": "ok" if db == "ok" else "degraded", "db": db}, status=200 if db == "ok" else 503)
