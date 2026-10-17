"""Board 37 endpoints G1–G13, W1–W2, D1–D4, A1–A2 (docs/v2/37-integrations-github-gitlab.md §5)."""

from django.http import HttpResponseNotFound, HttpResponseRedirect
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from core.access.permissions import MEMBER, ScopedView
from core.common.params import body
from core.common.throttles import DevBranchThrottle, DevLinkThrottle, IntegrationConnectThrottle, WebhookThrottle
from core.workspaces.views import WorkspaceScopedView
from modules.tracking.projects.views import ProjectScopedView
from modules.tracking.tasks import selectors as task_selectors

from . import development, services, webhooks
from .serializers import (
    AuthorizeUrlOut,
    AutomationRuleSchema,
    AvailableRepositoryOut,
    ConfirmIn,
    DevBranchIn,
    DevItemOut,
    DevLinkIn,
    GitLabConnectIn,
    IntegrationOut,
    IntegrationsOverviewOut,
    ReconnectIn,
    RepositoriesIn,
    RepositoryOut,
    RepositoryScopeIn,
    TaskDevelopmentOut,
    WebhookReceivedOut,
)

TAGS = ["integrations"]


def _redirect(url: str) -> HttpResponseRedirect:
    """Browser legs (§10.3): never cached, no referrer leaks the code or state."""
    response = HttpResponseRedirect(url)
    response["Referrer-Policy"] = "no-referrer"
    response["Cache-Control"] = "no-store"
    return response


class AnonymousView(APIView):
    #: Anonymous or provider-facing: unscoped (core/common/scoping.py); the record is found by token or signature.
    cross_workspace = True

    authentication_classes: list = []
    permission_classes = [AllowAny]


# ───────────────────────── workspace scope ─────────────────────────


class IntegrationsOverviewView(WorkspaceScopedView):
    """G1: providers and connections (every member; non-managers see a filtered payload)."""

    required = {"GET": "core.workspace.view"}

    @extend_schema(tags=TAGS, responses={200: IntegrationsOverviewOut})
    def get(self, request, slug):
        return Response(services.overview(request.user, self.scope))


class GitHubConnectView(WorkspaceScopedView):
    """G2."""

    required = {"POST": "tracking.integration.manage"}
    throttle_classes = [IntegrationConnectThrottle]

    @extend_schema(tags=TAGS, request=None, responses={200: AuthorizeUrlOut})
    def post(self, request, slug):
        return Response(services.start_attempt(request.user, self.scope, "github"))


class GitLabConnectView(WorkspaceScopedView):
    """G3: OAuth → 200 {authorizeUrl}; token → 201 Integration."""

    required = {"POST": "tracking.integration.manage"}
    throttle_classes = [IntegrationConnectThrottle]

    @extend_schema(tags=TAGS, request=GitLabConnectIn, responses={200: AuthorizeUrlOut, 201: IntegrationOut})
    def post(self, request, slug):
        data, code = services.connect_gitlab(request.user, self.scope, body(request))
        return Response(data, status=code)


class ConfirmView(WorkspaceScopedView):
    """G6: any mismatch (attempt, user, token, expiry, permission) is 404."""

    required = {"POST": MEMBER}

    @extend_schema(tags=TAGS, request=ConfirmIn, responses={200: IntegrationOut})
    def post(self, request, slug):
        return Response(services.confirm(request.user, self.scope, body(request)))


# ───────────────────────── browser legs ─────────────────────────


@extend_schema(tags=TAGS, request=None, responses={302: None})
class GitHubSetupView(AnonymousView):
    """G4: GitHub's Setup URL."""

    def get(self, request):
        return _redirect(services.github_setup(request.query_params))


@extend_schema(tags=TAGS, request=None, responses={302: None})
class CallbackView(AnonymousView):
    """G5: the OAuth/App callback for GitHub and GitLab."""

    provider = "github"

    def get(self, request):
        return _redirect(services.callback(self.provider, request.query_params))


class GitLabCallbackView(CallbackView):
    provider = "gitlab"


@extend_schema(tags=TAGS, request=None, responses={302: None})
class FakeAuthorizeView(AnonymousView):
    """§7.8: the fake provider's consent page (404 unless INTEGRATIONS_PROVIDER_BACKEND=fake)."""

    def get(self, request):
        url = services.fake_authorize(request.query_params)
        return _redirect(url) if url else HttpResponseNotFound()


# ───────────────────────── integration scope ─────────────────────────


class IntegrationScopedView(ScopedView):
    """Scope = the integration's workspace (non-members get 404)."""

    def get_scope(self):
        self.integration = services.integration_for(self.request.user, self.kwargs["integration_id"])
        return self.integration.workspace


class IntegrationDetailView(IntegrationScopedView):
    """G7 read; G13 disconnect."""

    required = {"GET": "core.workspace.view", "DELETE": "tracking.integration.manage"}

    @extend_schema(tags=TAGS, responses={200: IntegrationOut})
    def get(self, request, integration_id):
        return Response(services.integration_payload(request.user, self.integration))

    @extend_schema(tags=TAGS, responses={204: None})
    def delete(self, request, integration_id):
        services.disconnect(request.user, self.integration)
        return Response(status=status.HTTP_204_NO_CONTENT)


class AvailableRepositoriesView(IntegrationScopedView):
    """G8."""

    required = {"GET": "tracking.integration.manage"}

    @extend_schema(
        tags=TAGS, parameters=[OpenApiParameter("q", str)], responses={200: AvailableRepositoryOut(many=True)}
    )
    def get(self, request, integration_id):
        return Response(services.available_repositories(self.integration, request.query_params.get("q", "")[:60]))


class IntegrationRepositoriesView(IntegrationScopedView):
    """G9: replace the tracked set."""

    required = {"PUT": "tracking.integration.manage"}

    @extend_schema(tags=TAGS, request=RepositoriesIn, responses={200: IntegrationOut})
    def put(self, request, integration_id):
        return Response(services.set_repositories(request.user, self.integration, body(request)))


class IntegrationSyncView(IntegrationScopedView):
    """G11: "Sync now"."""

    required = {"POST": "tracking.integration.manage"}

    @extend_schema(tags=TAGS, request=None, responses={202: IntegrationOut})
    def post(self, request, integration_id):
        return Response(services.request_sync(request.user, self.integration), status=status.HTTP_202_ACCEPTED)


class IntegrationReconnectView(IntegrationScopedView):
    """G12."""

    required = {"POST": "tracking.integration.manage"}
    throttle_classes = [IntegrationConnectThrottle]

    @extend_schema(tags=TAGS, request=ReconnectIn, responses={200: IntegrationOut})
    def post(self, request, integration_id):
        return Response(services.reconnect(request.user, self.integration, body(request)))


class RepositoryDetailView(ScopedView):
    """G10: project scope of one tracked repository."""

    required = {"PATCH": "tracking.integration.manage"}

    def get_scope(self):
        self.repo = services.repository_for(self.request.user, self.kwargs["repository_id"])
        return self.repo.workspace

    @extend_schema(tags=TAGS, request=RepositoryScopeIn, responses={200: RepositoryOut})
    def patch(self, request, repository_id):
        return Response(services.scope_repository(request.user, self.repo, body(request)))


# ───────────────────────── webhooks ─────────────────────────


class _WebhookView(AnonymousView):
    throttle_classes = [WebhookThrottle]


@extend_schema(tags=TAGS, request=None, responses={200: WebhookReceivedOut, 202: WebhookReceivedOut})
class GitHubWebhookView(_WebhookView):
    """W1: X-Hub-Signature-256 (HMAC-SHA256)."""

    def post(self, request):
        code, data = webhooks.receive_github(request)
        return Response(data, status=code)


@extend_schema(tags=TAGS, request=None, responses={200: WebhookReceivedOut, 202: WebhookReceivedOut})
class GitLabWebhookView(_WebhookView):
    """W2: X-Gitlab-Token (per integration)."""

    def post(self, request, integration_id):
        code, data = webhooks.receive_gitlab(request, integration_id)
        return Response(data, status=code)


# ───────────────────────── task development ─────────────────────────


class TaskRefScopedView(ScopedView):
    def get_scope(self):
        self.task = task_selectors.task_by_id_or_key(self.request.user, self.kwargs["task_ref"])
        return self.task.project


class TaskDevelopmentView(TaskRefScopedView):
    """D1."""

    required = {"GET": "tracking.project.view"}

    @extend_schema(tags=TAGS, responses={200: TaskDevelopmentOut})
    def get(self, request, task_ref):
        return Response(development.development(self.task))


class TaskDevLinksView(TaskRefScopedView):
    """D2: link a PR/MR, commit or branch by URL."""

    required = {"POST": "tracking.development.link"}
    throttle_classes = [DevLinkThrottle]

    @extend_schema(tags=TAGS, request=DevLinkIn, responses={200: DevItemOut, 201: DevItemOut})
    def post(self, request, task_ref):
        data, code = development.link(request.user, self.task, body(request))
        return Response(data, status=code)


class TaskDevLinkDetailView(TaskRefScopedView):
    """D3."""

    required = {"DELETE": "tracking.development.link"}

    @extend_schema(tags=TAGS, responses={204: None})
    def delete(self, request, task_ref, link_id):
        development.unlink(request.user, self.task, link_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TaskDevBranchesView(TaskRefScopedView):
    """D4: create a branch from the repository's default branch."""

    required = {"POST": "tracking.development.link"}
    throttle_classes = [DevBranchThrottle]

    @extend_schema(tags=TAGS, request=DevBranchIn, responses={201: DevItemOut})
    def post(self, request, task_ref):
        return Response(development.create_branch(request.user, self.task, body(request)), status=201)


class DevAutomationView(ProjectScopedView):
    """A1 / A2."""

    required = {"GET": "tracking.project.view", "PUT": "tracking.status.manage"}

    @extend_schema(tags=TAGS, responses={200: AutomationRuleSchema(many=True)})
    def get(self, request, project_id):
        return Response(development.rules(self.scope))

    @extend_schema(tags=TAGS, request=AutomationRuleSchema(many=True), responses={200: AutomationRuleSchema(many=True)})
    def put(self, request, project_id):
        return Response(development.set_rules(request.user, self.scope, request.data))
