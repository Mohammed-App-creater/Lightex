"""`POST /api/v1/internal/jobs/{name}`: external cron (free hosts without a scheduler) triggers a job.

No user auth: the caller proves itself with the shared secret header `X-Jobs-Secret` (setting `JOBS_SECRET`). With no
secret configured the endpoint refuses everything.
"""

import hmac

from django.conf import settings
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from core.common.exceptions import forbidden
from core.common.params import body

from . import services

SECRET_HEADER = "X-Jobs-Secret"  # noqa: S105 (a header name, not a secret)


def secret_ok(given: str | None) -> bool:
    secret = (getattr(settings, "JOBS_SECRET", "") or "").strip()
    if not secret or not given:
        return False
    return hmac.compare_digest(given.encode(), secret.encode())


JobRunOut = inline_serializer(
    "JobRun",
    {
        "job": serializers.CharField(),
        "ran": serializers.IntegerField(),
        "skipped": serializers.IntegerField(),
        "failed": serializers.IntegerField(),
        "workspaces": inline_serializer(
            "JobRunWorkspace",
            {
                "workspaceId": serializers.UUIDField(),
                "status": serializers.ChoiceField(choices=["ran", "skipped", "failed"]),
                "error": serializers.CharField(required=False, help_text="The exception class name (failed only)."),
            },
            many=True,
        ),
    },
)


class JobRunView(APIView):
    #: Not about one workspace: unscoped (core/common/scoping.py); the runner scopes each workspace itself.
    cross_workspace = True

    authentication_classes: list = []
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["internal"],
        operation_id="internal_jobs_run",
        auth=[],
        parameters=[OpenApiParameter(SECRET_HEADER, str, OpenApiParameter.HEADER, required=True)],
        request=inline_serializer(
            "JobRunIn", {"workspaceId": serializers.UUIDField(required=False, help_text="Only this workspace.")}
        ),
        responses={200: JobRunOut},
    )
    def post(self, request, name):
        if not secret_ok(request.headers.get(SECRET_HEADER)):
            raise forbidden("A valid jobs secret is required.")
        workspace_id = body(request).get("workspaceId") or None
        return Response(services.run_job(name, workspace_id=workspace_id).as_dict())
