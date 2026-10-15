from django.urls import path

from . import views

W = "workspaces/<str:slug>/integrations"
I = "integrations/<uuid:integration_id>"  # noqa: E741
T = "tasks/<str:task_ref>/development"

urlpatterns = [
    path(W, views.IntegrationsOverviewView.as_view(), name="workspace-integrations"),
    path(f"{W}/github/connect", views.GitHubConnectView.as_view(), name="integration-github-connect"),
    path(f"{W}/gitlab/connect", views.GitLabConnectView.as_view(), name="integration-gitlab-connect"),
    path(f"{W}/confirm", views.ConfirmView.as_view(), name="integration-confirm"),
    path("integrations/github/setup", views.GitHubSetupView.as_view(), name="integration-github-setup"),
    path("integrations/github/callback", views.CallbackView.as_view(), name="integration-github-callback"),
    path("integrations/gitlab/callback", views.GitLabCallbackView.as_view(), name="integration-gitlab-callback"),
    path("integrations/fake/authorize", views.FakeAuthorizeView.as_view(), name="integration-fake-authorize"),
    path(I, views.IntegrationDetailView.as_view(), name="integration-detail"),
    path(f"{I}/available-repositories", views.AvailableRepositoriesView.as_view(), name="integration-available-repos"),
    path(f"{I}/repositories", views.IntegrationRepositoriesView.as_view(), name="integration-repositories"),
    path(f"{I}/sync", views.IntegrationSyncView.as_view(), name="integration-sync"),
    path(f"{I}/reconnect", views.IntegrationReconnectView.as_view(), name="integration-reconnect"),
    path("repositories/<uuid:repository_id>", views.RepositoryDetailView.as_view(), name="repository-detail"),
    path("webhooks/github", views.GitHubWebhookView.as_view(), name="webhook-github"),
    path("webhooks/gitlab/<uuid:integration_id>", views.GitLabWebhookView.as_view(), name="webhook-gitlab"),
    path(T, views.TaskDevelopmentView.as_view(), name="task-development"),
    path(f"{T}/links", views.TaskDevLinksView.as_view(), name="task-development-links"),
    path(f"{T}/links/<str:link_id>", views.TaskDevLinkDetailView.as_view(), name="task-development-link-detail"),
    path(f"{T}/branches", views.TaskDevBranchesView.as_view(), name="task-development-branches"),
    path("projects/<uuid:project_id>/dev-automation", views.DevAutomationView.as_view(), name="project-dev-automation"),
]
