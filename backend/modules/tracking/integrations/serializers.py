"""OpenAPI shapes for board 37 (docs/v2/37-integrations-github-gitlab.md §5.1, §5.6, §5.8). Responses are built by
`payloads.py`; these serializers only document them."""

from rest_framework import serializers

PROVIDER = ["github", "gitlab"]
CHECK_STATE = ["passing", "failing", "running"]
ERROR_CODES = [
    "token_expired",
    "token_revoked",
    "installation_suspended",
    "installation_removed",
    "insufficient_scope",
    "unreachable",
    "webhook_failing",
]


class ProviderInfoOut(serializers.Serializer):
    provider = serializers.ChoiceField(choices=PROVIDER)
    name = serializers.CharField()
    available = serializers.BooleanField()
    methods = serializers.ListField(child=serializers.ChoiceField(choices=["app", "oauth", "token"]))
    oauthBaseUrl = serializers.CharField(allow_null=True)
    canCreateBranch = serializers.BooleanField()


class AccountOut(serializers.Serializer):
    login = serializers.CharField()
    kind = serializers.ChoiceField(choices=["organization", "user", "bot"])
    url = serializers.CharField()


class IntegrationErrorOut(serializers.Serializer):
    code = serializers.ChoiceField(choices=ERROR_CODES)
    message = serializers.CharField()
    since = serializers.DateTimeField()


class RepositoryOut(serializers.Serializer):
    id = serializers.UUIDField()
    integrationId = serializers.UUIDField()
    provider = serializers.ChoiceField(choices=PROVIDER)
    externalId = serializers.CharField()
    fullPath = serializers.CharField()
    owner = serializers.CharField()
    name = serializers.CharField()
    visibility = serializers.ChoiceField(choices=["public", "private", "internal"])
    defaultBranch = serializers.CharField()
    url = serializers.CharField()
    allProjects = serializers.BooleanField()
    projectIds = serializers.ListField(child=serializers.UUIDField())
    openPullRequests = serializers.IntegerField()
    syncState = serializers.ChoiceField(choices=["idle", "queued", "syncing", "paused", "failed"])
    lastSyncedAt = serializers.DateTimeField(allow_null=True)
    canCreateBranch = serializers.BooleanField()


class IntegrationOut(serializers.Serializer):
    id = serializers.UUIDField()
    provider = serializers.ChoiceField(choices=PROVIDER)
    authKind = serializers.ChoiceField(choices=["github_app", "gitlab_oauth", "gitlab_token"])
    baseUrl = serializers.CharField()
    account = AccountOut()
    status = serializers.ChoiceField(choices=["active", "error"])
    error = IntegrationErrorOut(allow_null=True)
    connectedBy = serializers.UUIDField(allow_null=True)
    connectedAt = serializers.DateTimeField()
    lastSyncedAt = serializers.DateTimeField(allow_null=True)
    syncing = serializers.BooleanField()
    nextSyncAt = serializers.DateTimeField(allow_null=True)
    tokenExpiresAt = serializers.DateTimeField(allow_null=True)
    manageUrl = serializers.CharField(allow_null=True)
    repositories = RepositoryOut(many=True)


class IntegrationsOverviewOut(serializers.Serializer):
    providers = ProviderInfoOut(many=True)
    integrations = IntegrationOut(many=True)


class AuthorizeUrlOut(serializers.Serializer):
    authorizeUrl = serializers.CharField()


class GitLabConnectIn(serializers.Serializer):
    method = serializers.ChoiceField(choices=["oauth", "token"])
    baseUrl = serializers.CharField(required=False, help_text="token method: https:// instance URL")
    token = serializers.CharField(required=False, help_text="token method: group/project access token, scope api")


class ConfirmIn(serializers.Serializer):
    attempt = serializers.UUIDField()
    token = serializers.CharField()


class ReconnectIn(serializers.Serializer):
    token = serializers.CharField(required=False, help_text="GitLab token mode only")


class AvailableRepositoryOut(serializers.Serializer):
    externalId = serializers.CharField()
    fullPath = serializers.CharField()
    owner = serializers.CharField()
    name = serializers.CharField()
    visibility = serializers.ChoiceField(choices=["public", "private", "internal"])
    updatedAt = serializers.DateTimeField(allow_null=True)
    tracked = serializers.BooleanField()
    trackedElsewhere = serializers.BooleanField()


class TrackedRepositoryIn(serializers.Serializer):
    externalId = serializers.CharField()
    projectIds = serializers.ListField(child=serializers.UUIDField(), required=False, help_text="omitted or [] = all")


class RepositoriesIn(serializers.Serializer):
    repositories = TrackedRepositoryIn(many=True, help_text="The complete tracked set, 1–200 items.")


class RepositoryScopeIn(serializers.Serializer):
    projectIds = serializers.ListField(child=serializers.UUIDField(), help_text="[] = all projects")


class RepoRefOut(serializers.Serializer):
    id = serializers.UUIDField()
    fullPath = serializers.CharField()


class DevAuthorOut(serializers.Serializer):
    login = serializers.CharField()
    name = serializers.CharField(allow_null=True)
    userId = serializers.UUIDField(allow_null=True)


class DevCheckOut(serializers.Serializer):
    name = serializers.CharField()
    state = serializers.ChoiceField(choices=CHECK_STATE)
    durationSec = serializers.IntegerField(allow_null=True)
    url = serializers.CharField(allow_null=True)


class DevChecksOut(serializers.Serializer):
    state = serializers.ChoiceField(choices=CHECK_STATE)
    passed = serializers.IntegerField()
    total = serializers.IntegerField()
    items = DevCheckOut(many=True)


class DevItemOut(serializers.Serializer):
    """`DevPullRequest | DevBranch | DevCommit`, discriminated by `kind`."""

    id = serializers.UUIDField()
    kind = serializers.ChoiceField(choices=["pull_request", "branch", "commit"])
    provider = serializers.ChoiceField(choices=PROVIDER)
    repository = RepoRefOut(allow_null=True)
    repoFullPath = serializers.CharField()
    number = serializers.IntegerField(required=False, help_text="pull_request")
    ref = serializers.CharField(required=False, help_text="pull_request: #214 (GitHub) or !12 (GitLab)")
    title = serializers.CharField(required=False, help_text="pull_request")
    url = serializers.CharField()
    state = serializers.CharField(required=False, help_text="PR: open|draft|merged|closed; branch: active|deleted")
    headBranch = serializers.CharField(required=False)
    baseBranch = serializers.CharField(required=False)
    author = DevAuthorOut(required=False)
    checks = DevChecksOut(required=False, allow_null=True)
    approvals = serializers.IntegerField(required=False)
    linkSource = serializers.ChoiceField(choices=["auto", "manual", "created"])
    createdAt = serializers.DateTimeField(required=False)
    updatedAt = serializers.DateTimeField(required=False)
    mergedAt = serializers.DateTimeField(required=False, allow_null=True)
    closedAt = serializers.DateTimeField(required=False, allow_null=True)
    name = serializers.CharField(required=False, help_text="branch")
    aheadBy = serializers.IntegerField(required=False, allow_null=True, help_text="branch")
    sha = serializers.CharField(required=False, help_text="commit")
    shortSha = serializers.CharField(required=False, help_text="commit")
    message = serializers.CharField(required=False, help_text="commit subject")
    committedAt = serializers.DateTimeField(required=False, help_text="commit")


class DevRepositoryOut(serializers.Serializer):
    id = serializers.UUIDField()
    provider = serializers.ChoiceField(choices=PROVIDER)
    fullPath = serializers.CharField()
    name = serializers.CharField()
    defaultBranch = serializers.CharField()
    canCreateBranch = serializers.BooleanField()


class TaskDevelopmentOut(serializers.Serializer):
    taskId = serializers.UUIDField()
    taskKey = serializers.CharField()
    enabled = serializers.BooleanField()
    suggestedBranch = serializers.CharField()
    repositories = DevRepositoryOut(many=True)
    pullRequests = DevItemOut(many=True)
    branches = DevItemOut(many=True)
    commits = DevItemOut(many=True)
    commitTotal = serializers.IntegerField()
    syncedAt = serializers.DateTimeField(allow_null=True)


class DevLinkIn(serializers.Serializer):
    url = serializers.CharField(help_text="PR/MR, commit or branch URL of a tracked repository")


class DevBranchIn(serializers.Serializer):
    repositoryId = serializers.UUIDField()
    name = serializers.CharField(help_text="1–80 characters: letters, numbers, - _ . /")


class AutomationRuleSchema(serializers.Serializer):
    trigger = serializers.ChoiceField(choices=["branch_created", "pr_opened", "pr_merged"])
    enabled = serializers.BooleanField()
    statusId = serializers.UUIDField(allow_null=True)


class WebhookReceivedOut(serializers.Serializer):
    received = serializers.BooleanField()
    duplicate = serializers.BooleanField(required=False)


class TaskDevSummaryPrOut(serializers.Serializer):
    provider = serializers.ChoiceField(choices=PROVIDER)
    number = serializers.IntegerField()
    ref = serializers.CharField()
    state = serializers.ChoiceField(choices=["open", "draft", "merged", "closed"])
    checks = serializers.ChoiceField(choices=CHECK_STATE, allow_null=True)
    checksPassed = serializers.IntegerField()
    checksTotal = serializers.IntegerField()
    approvals = serializers.IntegerField()
    baseBranch = serializers.CharField()
    mergedAt = serializers.DateTimeField(allow_null=True)


class TaskDevSummaryOut(serializers.Serializer):
    pr = TaskDevSummaryPrOut(allow_null=True)
    prCount = serializers.IntegerField()
    branchCount = serializers.IntegerField()
    commitCount = serializers.IntegerField()
