"""Board 40 endpoints I1–I9 (docs/v2/40-import-wizard.md §4)."""

from django.conf import settings
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.response import Response

from apps.access.permissions import MEMBER, ScopedView
from apps.collaboration.storage import expires_at
from apps.common.params import body, filter_value
from apps.common.throttles import ImportThrottle, UploadThrottle
from apps.common.utils import iso
from apps.projects.views import ProjectScopedView

from . import selectors, services
from .serializers import (
    ImportCreateIn,
    ImportCreateOut,
    ImportJobOut,
    ImportJobSummariesOut,
    ImportMappingIn,
    ImportReportOut,
    ImportRowsPageOut,
)


class ProjectImportsView(ProjectScopedView):
    """I1 create a job + upload ticket; I9 the project's import history. Both need `can_import`."""

    required = {"GET": "project.import", "POST": "project.import"}

    def get_throttles(self):
        if self.request.method == "POST":
            return [UploadThrottle(), ImportThrottle()]
        return super().get_throttles()

    @extend_schema(tags=["imports"], responses={200: ImportJobSummariesOut})
    def get(self, request, project_id):
        services.require_import(request.user, self.scope)
        return Response([selectors.summary_data(j) for j in services.recent_jobs(self.scope)])

    @extend_schema(tags=["imports"], request=ImportCreateIn, responses={201: ImportCreateOut})
    def post(self, request, project_id):
        job, url, headers = services.create_job(request.user, self.scope, body(request))
        return Response(
            {
                "job": selectors.job_data(job),
                "upload": {
                    "uploadId": str(job.pk),
                    "url": url,
                    "method": "PUT",
                    "headers": headers,
                    "expiresAt": iso(expires_at(settings.UPLOAD_URL_TTL_SECONDS)),
                },
            },
            status=status.HTTP_201_CREATED,
        )


class ImportScopedView(ScopedView):
    """Scope = the job's project (job → project → membership, like v1)."""

    def get_scope(self):
        self.job = selectors.job_for(self.request.user, self.kwargs["import_id"])
        return self.job.project


class ImportDetailView(ImportScopedView):
    """I3: the job. Polled while queued/running; re-dispatches a runner whose heartbeat went stale."""

    required = {"GET": "project.import"}

    @extend_schema(tags=["imports"], responses={200: ImportJobOut})
    def get(self, request, import_id):
        if services.recover_if_stale(self.job):
            self.job.refresh_from_db()
        return Response(selectors.job_data(self.job))


class ImportAnalyzeView(ImportScopedView):
    required = {"POST": "project.import"}

    @extend_schema(tags=["imports"], request=None, responses={200: ImportJobOut})
    def post(self, request, import_id):
        return Response(selectors.job_data(services.analyze(request.user, self.job)))


class ImportMappingView(ImportScopedView):
    required = {"PUT": "project.import"}

    @extend_schema(tags=["imports"], request=ImportMappingIn, responses={200: ImportJobOut})
    def put(self, request, import_id):
        return Response(selectors.job_data(services.save_mapping(request.user, self.job, body(request))))


class ImportRowsView(ImportScopedView):
    required = {"GET": "project.import"}

    @extend_schema(
        tags=["imports"],
        parameters=[
            OpenApiParameter("filter[outcome]", str, enum=list(selectors.OUTCOME_FILTERS)),
            OpenApiParameter("limit", int),
            OpenApiParameter("cursor", str),
        ],
        responses={200: ImportRowsPageOut},
    )
    def get(self, request, import_id):
        return Response(selectors.rows_page(self.job, request.query_params, filter_value(request, "outcome")))


class ImportStartView(ImportScopedView):
    required = {"POST": "project.import"}

    @extend_schema(tags=["imports"], request=None, responses={202: ImportJobOut})
    def post(self, request, import_id):
        job = services.start(request.user, self.job)
        return Response(selectors.job_data(job), status=status.HTTP_202_ACCEPTED)


class ImportCancelView(ImportScopedView):
    """The creator, or a holder of project.update (checked by the service)."""

    required = {"POST": MEMBER}

    @extend_schema(tags=["imports"], request=None, responses={200: ImportJobOut})
    def post(self, request, import_id):
        return Response(selectors.job_data(services.cancel(request.user, self.job)))


class ImportErrorReportView(ImportScopedView):
    required = {"GET": "project.import"}

    @extend_schema(tags=["imports"], responses={200: ImportReportOut})
    def get(self, request, import_id):
        return Response(services.error_report(self.job))
