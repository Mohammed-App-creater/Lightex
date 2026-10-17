"""Board 37 models (docs/v2/37-integrations-github-gitlab.md §3). Secrets are encrypted per row (crypto.py)."""

from __future__ import annotations

import json
from typing import Any

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone

from core.common.models import BaseModel, WorkspaceScopedModel

from . import crypto

PROVIDERS = [("github", "GitHub"), ("gitlab", "GitLab")]
PROVIDER_NAME = dict(PROVIDERS)


class EncryptedFieldsMixin:
    """`get_secret`/`set_secret` for the encrypted text columns; decrypted values never leave the caller."""

    pk: Any

    def get_secret(self, field: str) -> str:
        return crypto.decrypt(getattr(self, field) or "", crypto.aad_for(self, field))

    def set_secret(self, field: str, value: str) -> None:
        setattr(self, field, crypto.encrypt(value or "", crypto.aad_for(self, field)))


class Integration(EncryptedFieldsMixin, WorkspaceScopedModel):
    AUTH_KINDS = [("github_app", "GitHub App"), ("gitlab_oauth", "GitLab OAuth"), ("gitlab_token", "GitLab token")]
    STATUSES = [("pending", "Pending"), ("active", "Active"), ("error", "Error"), ("disconnecting", "Disconnecting")]

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="integrations")
    provider = models.CharField(max_length=8, choices=PROVIDERS)
    auth_kind = models.CharField(max_length=16, choices=AUTH_KINDS)
    base_url = models.CharField(max_length=200)
    account_external_id = models.CharField(max_length=64)
    account_login = models.CharField(max_length=100)
    account_kind = models.CharField(max_length=16, default="organization")
    account_url = models.CharField(max_length=300, blank=True, default="")
    status = models.CharField(max_length=16, choices=STATUSES, default="pending")
    error_code = models.CharField(max_length=32, blank=True, default="")
    error_since = models.DateTimeField(null=True, blank=True)
    credentials = models.TextField(blank=True, default="")
    webhook_secret = models.TextField(blank=True, default="")
    token_expires_at = models.DateTimeField(null=True, blank=True)
    scopes = models.JSONField(default=list, blank=True)
    connected_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    connected_at = models.DateTimeField(null=True, blank=True)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_delivery_at = models.DateTimeField(null=True, blank=True)
    sync_requested_at = models.DateTimeField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "base_url", "account_external_id"],
                condition=Q(provider="github") & ~Q(status="disconnecting"),
                name="integration_github_installation_unique",
            ),
            models.UniqueConstraint(
                fields=["workspace", "provider", "base_url", "account_external_id"], name="integration_unique_per_ws"
            ),
        ]
        indexes = [models.Index(fields=["status", "last_synced_at"], name="integration_catchup")]

    def __str__(self) -> str:
        return f"{self.provider_name} · {self.account_login}"

    @property
    def provider_name(self) -> str:
        return PROVIDER_NAME.get(self.provider, self.provider)

    def get_credentials(self) -> dict[str, Any]:
        raw = self.get_secret("credentials")
        return json.loads(raw) if raw else {}

    def set_credentials(self, value: dict[str, Any]) -> None:
        self.set_secret("credentials", json.dumps(value) if value else "")


class Repository(WorkspaceScopedModel):
    SYNC_STATES = [("idle", "Idle"), ("queued", "Queued"), ("syncing", "Syncing"), ("failed", "Failed")]

    integration = models.ForeignKey(Integration, on_delete=models.CASCADE, related_name="repositories")
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    external_id = models.CharField(max_length=64)
    full_path = models.CharField(max_length=300)
    owner_path = models.CharField(max_length=255)
    name = models.CharField(max_length=100)
    visibility = models.CharField(max_length=10, default="private")
    default_branch = models.CharField(max_length=255, default="main")
    web_url = models.CharField(max_length=300)
    all_projects = models.BooleanField(default=True)
    projects = models.ManyToManyField("projects.Project", through="RepositoryProject", related_name="+", blank=True)
    hook_id = models.CharField(max_length=32, blank=True, default="")
    open_pr_count = models.PositiveIntegerField(default=0)
    sync_state = models.CharField(max_length=10, choices=SYNC_STATES, default="idle")
    last_synced_at = models.DateTimeField(null=True, blank=True)
    backfilled_at = models.DateTimeField(null=True, blank=True)
    archived = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["integration", "external_id"], name="repo_unique_per_integration")
        ]
        indexes = [models.Index(fields=["workspace", "full_path"], name="repo_ws_path")]

    def __str__(self) -> str:
        return self.full_path


class RepositoryProject(WorkspaceScopedModel):
    workspace_parent = "repository"

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    repository = models.ForeignKey(Repository, on_delete=models.CASCADE, related_name="+")
    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["repository", "project"], name="repo_project_unique")]


class ConnectAttempt(EncryptedFieldsMixin, WorkspaceScopedModel):
    MODES = [("connect", "Connect"), ("reconnect", "Reconnect")]
    STATUSES = [
        ("started", "Started"),
        ("called_back", "Called back"),
        ("confirmed", "Confirmed"),
        ("failed", "Failed"),
        ("expired", "Expired"),
    ]

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    provider = models.CharField(max_length=8, choices=PROVIDERS)
    mode = models.CharField(max_length=10, choices=MODES, default="connect")
    integration = models.ForeignKey(
        Integration, null=True, blank=True, on_delete=models.CASCADE, related_name="connect_attempts"
    )
    state_hash = models.CharField(max_length=64, unique=True)
    pkce_verifier = models.TextField(blank=True, default="")
    installation_id = models.CharField(max_length=32, blank=True, default="")
    confirm_hash = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(max_length=12, choices=STATUSES, default="started")
    error_code = models.CharField(max_length=32, blank=True, default="")
    expires_at = models.DateTimeField()


class WebhookDelivery(BaseModel):
    """The inbound webhook queue. Global, not workspace-scoped: a delivery is stored before its integration (and so
    its workspace) is known, and some never match one."""

    STATUSES = [
        ("received", "Received"),
        ("processing", "Processing"),
        ("processed", "Processed"),
        ("ignored", "Ignored"),
        ("failed", "Failed"),
    ]

    provider = models.CharField(max_length=8, choices=PROVIDERS)
    delivery_id = models.CharField(max_length=80)
    integration = models.ForeignKey(
        Integration, null=True, blank=True, on_delete=models.SET_NULL, related_name="deliveries"
    )
    event = models.CharField(max_length=40)
    action = models.CharField(max_length=40, blank=True, default="")
    payload = models.JSONField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=STATUSES, default="received")
    attempts = models.PositiveSmallIntegerField(default=0)
    error = models.CharField(max_length=300, blank=True, default="")
    lease_token = models.UUIDField(null=True, blank=True)
    locked_at = models.DateTimeField(null=True, blank=True)
    processed_at = models.DateTimeField(null=True, blank=True)
    received_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["provider", "delivery_id"], name="webhook_delivery_idempotent")]
        indexes = [
            models.Index(fields=["status", "received_at"], name="webhook_queue"),
            models.Index(fields=["received_at"], name="webhook_retention"),
        ]


class SyncRun(WorkspaceScopedModel):
    workspace_parent = "integration"

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    KINDS = [("backfill", "Backfill"), ("sync", "Sync"), ("catchup", "Catch-up")]
    STATUSES = [
        ("queued", "Queued"),
        ("running", "Running"),
        ("deferred", "Deferred"),
        ("done", "Done"),
        ("failed", "Failed"),
    ]
    ACTIVE = ("queued", "running", "deferred")

    integration = models.ForeignKey(Integration, on_delete=models.CASCADE, related_name="sync_runs")
    repository = models.ForeignKey(Repository, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=10, choices=KINDS)
    status = models.CharField(max_length=10, choices=STATUSES, default="queued")
    run_after = models.DateTimeField(default=timezone.now)
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    lease_token = models.UUIDField(null=True, blank=True)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
    stats = models.JSONField(default=dict, blank=True)
    error = models.CharField(max_length=300, blank=True, default="")
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["integration", "repository"],
                condition=Q(status__in=["queued", "running", "deferred"]),
                name="sync_one_active",
                nulls_distinct=False,
            )
        ]
        indexes = [models.Index(fields=["status", "run_after"], name="sync_queue")]


class AutomationRule(WorkspaceScopedModel):
    workspace_parent = "project"

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    TRIGGERS = [("branch_created", "Branch created"), ("pr_opened", "PR opened"), ("pr_merged", "PR merged")]

    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="dev_rules")
    trigger = models.CharField(max_length=16, choices=TRIGGERS)
    status = models.ForeignKey("projects.Status", on_delete=models.CASCADE, related_name="+")
    enabled = models.BooleanField(default=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        constraints = [models.UniqueConstraint(fields=["project", "trigger"], name="automation_rule_unique")]
