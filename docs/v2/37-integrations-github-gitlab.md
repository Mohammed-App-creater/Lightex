# v2 · Board 37: Integrations & development — GitHub and GitLab (API contract)

Status: **contract, not implemented.** The backend (Django + DRF, `backend/`) and the frontend (Next.js,
`frontend/`) are built from this document in parallel. Where this document is silent, the v1 conventions in
`docs/backend-plan.md`, `frontend/docs/api-contract.md` and `frontend/src/lib/api/*.ts` apply unchanged. So do the
contracts for board 39 (`docs/v2/39-fields-dependencies-time.md`), board 32 (`docs/v2/32-timeline-calendar.md`),
board 40 (`docs/v2/40-import-wizard.md`, background work) and board 33 (`docs/v2/33-dashboards-presence.md`, realtime
stream).

Design source: `frontend/design/clean/37-Integrations-amp-development.html`. Its frames are Not connected, Connecting,
Repo picker, Connected + status, Development section, Error (token expired), Loading, Board cards with PR indicator,
Mobile (390), Development · empty and Development · loading. Its `data-props` are theme (navy/dark/light) and role
(admin/member/viewer).
Precedence is unchanged: **docs and existing conventions win for behaviour; the design wins for appearance.** Every
conflict and how it was resolved is in §11.

**The user's requirement: GitHub and GitLab are both required**, including self-managed GitLab.

Contents: 0 Wire conventions · 1 Scope · 2 Providers and setup · 3 Data model · 4 Permissions · 5 Endpoints ·
6 Task-key matching · 7 Processing · 8 Side effects · 9 Frontend · 10 Security · 11 Conflicts · 12 Test plan ·
13 Open questions · 14 Delivery checklist.

**Summary of the change.**

- One new backend app, `apps/integrations`, with these models: `Integration`, `Repository`, `ConnectAttempt`,
  `WebhookDelivery`, `SyncRun` and `AutomationRule`. It also has a provider interface with three implementations:
  `github`, `gitlab` and `fake`.
- The reserved `tasks.ExternalLink` model gets the extra columns it needs and becomes the store for branches,
  commits and PRs/MRs that are linked to tasks.
- GitHub connects through a **GitHub App**. GitLab connects through an **OAuth application** (gitlab.com) or a
  **group/project access token** (gitlab.com or self-managed).
- Webhooks are verified, written to a delivery table and answered **within milliseconds**. They are processed after
  the response with board 40's dispatch pattern: Celery when a broker exists, otherwise a daemon thread. **No Redis
  is required.**
- Endpoints: 13 integration endpoints, 2 webhook receivers, 4 task development endpoints and 2 automation endpoints.
  Three payloads gain fields: `Task.dev`, `Project.devEnabled`, and `actorKind`/`actorName` on activity entries.
- Permissions: one new workspace key (`integration.manage`) and one new project key (`development.link`).
- Audit and activity: new audit actions and three new activity verbs. Automation status changes are made by a
  **system actor** (the integration).
- **One new Python dependency, `cryptography`.** It encrypts credentials at rest (AES-256-GCM) and signs the GitHub
  App's RS256 JWTs through the already-installed PyJWT. No new npm dependency.

---

## 0. Wire conventions (unchanged, restated so nobody guesses)

- Base `/api/v1`. JSON. camelCase fields; the only snake_case key is `my_permissions`.
- Timestamps are ISO-8601 UTC (`ISODateTime`).
- Errors: `{ "code": string, "message": string, "details": object }`. Validation is **422** `validation_failed`
  with `details.fields: { "<field path>": "<message>" }`.
- Paginated lists: `{ "data": T[], "nextCursor": string | null }`. Every list in this document is a bounded **plain
  array**.
- Status codes: create → **201**; async start → **202**; update → **200**; delete → **204**.
- Permission failure → 403 `forbidden` with `details.permission`. Not a workspace member → 404. Workspace member who
  is not on the project → 403 `project_membership_required` (v1, unchanged).
- Archived projects are read-only. `development.link` is **not** added to `ARCHIVED_ALLOWED`. Webhook-driven link
  updates still land on archived projects' tasks (§6.5), but automations never change them.
- IDs are UUIDs on the backend and opaque strings in the mock (`int_gh_platform`). Clients never parse ids.
- **Exceptions to "JSON only"**:
  - the two OAuth/App **browser callbacks** (§5.3) answer with `302` redirects;
  - the two **webhook receivers** (§5.5) accept provider-shaped bodies, not camelCase.

---

## 1. Scope

### 1.1 What board 37 shows

| Surface | Content (design) |
|---|---|
| **Workspace settings → Integrations** (`/[ws]/settings/integrations`) | **Source control**: a tile per provider (GitHub "Branches · Commits · Pull requests", GitLab "… · Merge requests") with "Connect GitHub" / "Connect GitLab", or a lock note for people who can't connect. **Connected card**: provider icon and name; badge "Connected" or the error badge ("Token expired"); meta "4 repos · last sync 2m" or "expired 3d ago · 4 repos paused". Actions: Sync now, Edit repos, Reconnect (in an error state), Disconnect. Repository rows: `org/name`, "12 open PRs", last sync / "syncing" / "paused". **Task keys**: three examples (Branch `prj-42-fix-reflow`, PR title `PRJ-42 Fix flaky board reflow`, Commit `fix(board): debounce reflow (PRJ-42)`) and a branch-name generator (task select, prefix plain or `feature/`, Copy). |
| Connect flow | Connect → "Waiting for authorization…" + Cancel → the provider's consent screen → **Choose repositories** |
| **Choose repositories** (modal) | Search; repositories grouped by org with a "select all" tri-state checkbox per org and `n/m`; each row shows name, visibility and when it was last updated; skeleton while loading; "No repositories match “q”" + Clear search; footer "4 selected", Cancel, "Connect 4 repos" / "Save · 4 repos" (disabled at 0) |
| **Disconnect** (alert dialog) | "Disconnect GitHub?" / "Linked PRs stay on tasks. Syncing stops." / Cancel (autofocus), Disconnect |
| Toasts | "GitHub connected · 4 repos", "Repositories updated", "GitHub reconnected", "GitHub disconnected" |
| **Task panel → Development** (above Description) | Header "Development" + count "4 PRs · 2 branches" + flash ("Branch created") + **Create branch** (popover: name input prefilled with the suggested slug, Copy, "from main in [repo ▾]", Cancel / Create ↵). **Pull requests**: state pill (Open / Merged / Draft / Closed), `#214`, title with the key highlighted, a checks button (Passing / Failing / Running) that expands the check rows (icon, name, state, duration), author avatar. **Branches**: name, repo, "3 ahead", copy. **Commits**: 7-char sha, message, author avatar, "1h". **Empty**: "No linked work yet", the suggested branch name with Copy, "Use PRJ-58 in a branch, PR or commit". **Loading**: skeleton. |
| **Board card PR indicator** | Chip `#214` in three states (failing, open, merged); tooltip "#214 · 2 of 3 checks failing", "#221 · checks passing · 1 review", "#187 · merged into main · Oct 6" |
| Mobile (390) | The settings page stacked, with touch targets |

The design does **not** show: automation rules, manual link/unlink, GitLab self-managed/token entry, or mapping
repositories to projects. All four are needed for the behaviour the user asked for, so §9 adds them with existing
primitives. Each one is recorded in §11.

### 1.2 Out of scope (this release)

- GitHub Enterprise Server. The provider takes a base URL, so it can be added later (§13 #1).
- Self-managed GitLab via **OAuth**. Self-managed instances connect with an access token (§13 #2).
- Bitbucket and other providers. Creating PRs/MRs from Lightex. Syncing issues. Posting comments back to the
  provider. Deployments/environments.

---

## 2. Providers and setup

### 2.1 GitHub: a GitHub App, not an OAuth App

| | GitHub App (chosen) | OAuth App |
|---|---|---|
| Repository access | **Fine-grained.** The org owner picks repositories at install time (all or selected) and can change them later | The `repo` scope gives full read/write access to **every** private repository the user can reach |
| Whose credential | The **installation**, owned by the org. It survives the connecting admin leaving the company | One person's token. It breaks when they leave or lose access |
| Token lifetime | Installation tokens last **1 hour**. They are minted on demand from the app's private key and never need a refresh token | Long-lived user tokens |
| Webhooks | **One app-level webhook** for every installation and repository, signed with one HMAC-SHA256 secret. No per-repo hook management, no `admin:repo_hook` scope | A hook has to be created in every repository, with the admin scope |
| Permissions | Declared per resource: Contents, Pull requests, Checks, Statuses, Metadata. Read-only where possible | Coarse scopes |
| Rate limit | Per installation, at least 5,000 requests/hour and growing with the org's size | Shared with everything else the user's token does |
| Identity | Branches are created by `lightex[bot]` | The user |
| Recovery | `GET /app/hook/deliveries` + redeliver after downtime (§7.6) | None |

**Install flow.** `Request user authorization (OAuth) during installation` stays **off**. Instead we use a **Setup
URL** and then a separate OAuth step. Both legs carry our `state`, so the connecting browser is verified on each leg
(§5.3):

1. The browser goes to `https://github.com/apps/<slug>/installations/new?state=<state>`.
2. GitHub sends the browser to the **Setup URL** with `installation_id`, `setup_action` and `state`.
3. The server redirects the browser to `https://github.com/login/oauth/authorize?client_id=…&state=<state>`.
4. GitHub sends the browser to the **Callback URL** with `code` and `state`.
5. The server exchanges the code for a user token and checks that `installation_id` is listed in that user's
   `GET /user/installations`. **Without this check, anyone could claim someone else's installation id.** It then
   **revokes the user token** (`DELETE /applications/{client_id}/token`). No user token is stored.

The rest of the flow uses **installation tokens only**:
`POST /app/installations/{id}/access_tokens`, authenticated with a JWT that is signed RS256 with the app private key,
with `iss` = the client ID, `iat` = now − 60 s and `exp` = now + 9 min.

**What the user creates on GitHub.** Go to Settings → Developer settings → GitHub Apps → New GitHub App. Create it
under the **organization** that owns the code, so ownership isn't tied to one person.

| Field | Value |
|---|---|
| GitHub App name | `Lightex` (one app per environment, e.g. `Lightex Staging`) |
| Homepage URL | `<FRONTEND_URL>` |
| Callback URL | `<API_PUBLIC_URL>/api/v1/integrations/github/callback` |
| Expire user authorization tokens | on (the default; we revoke immediately anyway) |
| Request user authorization (OAuth) during installation | **off** |
| Setup URL | `<API_PUBLIC_URL>/api/v1/integrations/github/setup` |
| Redirect on update | **on**, so that changing repository access returns to Lightex |
| Webhook → Active | on |
| Webhook URL | `<API_PUBLIC_URL>/api/v1/webhooks/github` |
| Webhook secret | 32+ random bytes (`python -c "import secrets;print(secrets.token_urlsafe(32))"`) → `GITHUB_WEBHOOK_SECRET` |
| Repository permissions | **Contents: Read and write** (write is only for "Create branch"; choose Read-only and set `GITHUB_BRANCH_CREATION=false` to turn that feature off). **Pull requests: Read-only.** **Checks: Read-only.** **Commit statuses: Read-only.** **Metadata: Read-only** (mandatory). Everything else: No access |
| Organization / account permissions | none |
| Subscribe to events | **Check run, Create, Delete, Pull request, Pull request review, Push, Repository, Status.** `installation` and `installation_repositories` are always delivered. |
| Where can this app be installed | "Any account" if other orgs will connect; "Only on this account" for a single-org deployment |

After saving, collect the **App ID**, **app slug** (from the public URL), **Client ID**, a **Client secret**
(Generate) and a **private key** (Generate → `.pem`).

### 2.2 GitLab: an OAuth application or an access token

| Mode | Where | Credential | Notes |
|---|---|---|---|
| `gitlab_oauth` | gitlab.com (or one self-managed instance configured as `GITLAB_BASE_URL`, §13 #2) | OAuth authorization code + **PKCE S256**, scope `api` | The access token lasts 2 h. The refresh token **rotates** on every refresh (§7.5). |
| `gitlab_token` | gitlab.com **and self-managed** (any instance URL) | A **group access token** (preferred) or a **project access token** with role **Maintainer** and scope `api`. A personal access token also works. | Pasted by an admin. The expiry is read from `GET /personal_access_tokens/self`. |

**Why `api` and not `read_api`:** creating project webhooks and branches needs `api`. Maintainer is the minimum
role that can manage project hooks. Lightex uses `api` only for the calls listed in §2.4.

**Webhooks.** One **project webhook** is created in every selected project
(`POST /projects/:id/hooks`):

- URL `<API_PUBLIC_URL>/api/v1/webhooks/gitlab/<integrationId>`;
- `token` = the integration's own random 32-byte secret;
- `push_events`, `merge_requests_events` and `pipeline_events` on, everything else off;
- `enable_ssl_verification: true`.

Group webhooks are not used, because they require GitLab Premium. GitLab sends the secret back as `X-Gitlab-Token`.

**What the user creates on GitLab (OAuth mode only).** Go to gitlab.com → Edit profile → Applications, or Group →
Settings → Applications (preferred, so ownership is the group's).

| Field | Value |
|---|---|
| Name | `Lightex` |
| Redirect URI | `<API_PUBLIC_URL>/api/v1/integrations/gitlab/callback` |
| Confidential | **on** |
| Scopes | **`api`** only |

Then collect the **Application ID** → `GITLAB_CLIENT_ID` and the **Secret** → `GITLAB_CLIENT_SECRET`.

**Token mode (each customer, nothing to set on the server).** Go to Group → Settings → Access tokens → Add new
token. Name it `Lightex`, give it role **Maintainer**, scope **`api`**, and an expiry date (GitLab ≥ 16 requires
one). Paste it into the Connect GitLab dialog together with the instance URL.

### 2.3 Server settings and environment

| Env var | Default | Purpose |
|---|---|---|
| `INTEGRATIONS_ENABLED` | `true` | Kill switch. When `false`: the receivers return 503, the connect endpoints return 503 `integrations_unavailable`, and the settings page shows the error state. |
| `INTEGRATIONS_PROVIDER_BACKEND` | `real` (dev: `fake` unless GitHub/GitLab vars are set; test: `fake`) | `real` \| `fake` (§7.8) |
| `INTEGRATIONS_RUNNER` | `celery` when a broker is configured, else `thread`; `inline` in tests | Same semantics as board 40's `IMPORT_RUNNER` |
| `INTEGRATIONS_ENCRYPTION_KEYS` | dev/test: derived from `DJANGO_SECRET_KEY` (§10.2); **required in prod** when any provider is configured | `kid:base64url(32 bytes)[,kid:…]`. The first key encrypts; all keys decrypt. |
| `GITHUB_APP_ID` | — | App ID |
| `GITHUB_APP_SLUG` | — | Used in `https://github.com/apps/<slug>/installations/new` |
| `GITHUB_APP_CLIENT_ID` | — | Client ID (also the JWT `iss`) |
| `GITHUB_APP_CLIENT_SECRET` | — | OAuth code exchange and user-token revocation |
| `GITHUB_APP_PRIVATE_KEY` | — | The `.pem` contents. `\n`-escaped or base64 are both accepted (Render's env editor keeps real newlines too). |
| `GITHUB_WEBHOOK_SECRET` | — | HMAC key for `X-Hub-Signature-256` |
| `GITHUB_BRANCH_CREATION` | `true` | `false` hides "Create branch" for GitHub repositories (`canCreateBranch: false`) |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | — | OAuth mode. Without them, GitLab offers token mode only. |
| `GITLAB_BASE_URL` | `https://gitlab.com` | The instance the OAuth app belongs to |
| `GITLAB_ALLOWED_HOSTS` | empty (= any public host) | Optional allow-list for self-managed hosts, e.g. `gitlab.example.com,*.corp.example` |
| `GITLAB_ALLOW_PRIVATE_NETWORKS` | `false` (dev: `true`) | Lets a self-managed URL resolve to private IPs. **Leave false in prod** (§10.4). |
| `INTEGRATION_BACKFILL_DAYS` | `30` | §7.4 |
| `INTEGRATION_BACKFILL_MAX_PRS` | `200` | Per repository |
| `INTEGRATION_CATCHUP_MINUTES` | `30` | §7.6 |
| `WEBHOOK_MAX_BODY_BYTES` | `5242880` (5 MB) | §7.1 |
| `WEBHOOK_RETENTION_DAYS` | `7` | §3.5 |
| Throttles | `webhook: 1200/min` per IP; `integration_connect: 10/hour`, `dev_branch: 30/hour`, `dev_link: 60/hour` per user | New scopes (`THROTTLE_WEBHOOK`, …) |

A provider is **available** (§5.2 `providers[].available`) only when its variables are set:

- GitHub: all six `GITHUB_*` values;
- GitLab: always available, because token mode needs no server setup; `oauth` appears in `methods` only when both
  `GITLAB_CLIENT_*` values are set.

`render.yaml` gets every secret above as `sync: false`, plus `INTEGRATIONS_ENCRYPTION_KEYS`, which is generated once
and **never regenerated**. `backend/.env.example` and `backend/README.md` document them.

### 2.4 The provider interface

`apps/integrations/providers/base.py`. `get_provider(key)` returns `GitHubProvider`, `GitLabProvider` or, when
`INTEGRATIONS_PROVIDER_BACKEND=fake`, `FakeProvider(key)` for both keys. Nothing outside `providers/` imports a
concrete provider.

```python
class Provider(Protocol):
    key: Literal["github", "gitlab"]

    # connect
    def authorize_url(self, attempt: ConnectAttempt) -> str: ...
    def complete(self, attempt: ConnectAttempt, params: Mapping[str, str]) -> ConnectResult: ...   # code exchange + verification
    def connect_with_token(self, base_url: str, token: str) -> ConnectResult: ...                  # gitlab_token only
    def revoke(self, integration: Integration) -> bool: ...

    # repositories
    def list_repositories(self, integration: Integration) -> list[RepoInfo]: ...                   # ≤ 1,000, cached 60 s
    def enable_repository(self, integration: Integration, repo: Repository) -> None: ...           # GitLab: create hook
    def disable_repository(self, integration: Integration, repo: Repository) -> None: ...          # GitLab: delete hook

    # webhooks
    def verify(self, request: HttpRequest, body: bytes, integration: Integration | None) -> bool: ...
    def delivery_meta(self, request: HttpRequest, body: bytes) -> DeliveryMeta: ...                 # id, event, action, account id
    def normalize(self, delivery: WebhookDelivery) -> list[DevEvent]: ...                           # §7.2

    # reads (backfill, sync, manual link, enrichment)
    def pull_requests(self, repo: Repository, *, updated_since: datetime | None, limit: int) -> Iterator[PullRequestInfo]: ...
    def branches(self, repo: Repository, *, limit: int) -> Iterator[BranchInfo]: ...
    def commits(self, repo: Repository, *, ref: str | None, since: datetime, limit: int) -> Iterator[CommitInfo]: ...
    def pull_request_commits(self, repo: Repository, number: int, *, limit: int) -> Iterator[CommitInfo]: ...
    def checks(self, repo: Repository, sha: str) -> list[CheckInfo]: ...
    def approvals(self, repo: Repository, number: int) -> int: ...
    def ahead_by(self, repo: Repository, branch: str) -> int | None: ...
    def resolve_url(self, integration: Integration, url: str) -> ResolvedObject | None: ...         # manual link

    # writes
    def create_branch(self, repo: Repository, name: str, from_ref: str) -> BranchInfo: ...
```

Every outbound call goes through `apps/integrations/http.py`. It uses the **stdlib** (`http.client`/`urllib`, like
`accounts/google.py`) and adds:

- timeouts: 10 s connect, 15 s read;
- a 5 MB response cap;
- **no redirect following**;
- the SSRF guard for GitLab hosts (§10.4);
- rate-limit header capture (§7.7);
- a `User-Agent: Lightex-Integrations/1` header.

The API calls each provider makes (minimal scopes):

| Purpose | GitHub (installation token unless noted) | GitLab |
|---|---|---|
| Verify the installer | `GET /user/installations` (user token, then revoked) | `GET /user`, `GET /personal_access_tokens/self` (token mode) |
| List repositories | `GET /installation/repositories` | `GET /projects?membership=true&min_access_level=40&simple=true` |
| Hooks | — (app webhook) | `POST/DELETE /projects/:id/hooks` |
| PRs/MRs | `GET /repos/{o}/{r}/pulls?state=all&sort=updated`, `GET …/pulls/{n}/reviews`, `GET …/pulls/{n}/commits` | `GET /projects/:id/merge_requests?updated_after=`, `GET …/merge_requests/:iid/approvals`, `GET …/merge_requests/:iid/commits` |
| Branches / commits | `GET …/branches`, `GET …/commits?since=`, `GET …/compare/{base}...{head}` | `GET …/repository/branches`, `GET …/repository/commits?since=`, `GET …/repository/compare` |
| Checks | `GET …/commits/{sha}/check-runs`, `GET …/commits/{sha}/status` | `GET …/pipelines?sha=`, `GET …/pipelines/:id/jobs` |
| Create branch | `GET …/git/ref/heads/{default}`, `POST …/git/refs` | `POST …/repository/branches` |
| Revoke | `DELETE /app/installations/{id}` (app JWT) | `POST /oauth/revoke`; token mode: `DELETE /personal_access_tokens/self` (bot tokens only, §7.9) |
| Recovery | `GET /app/hook/deliveries`, `POST /app/hook/deliveries/{id}/attempts` (app JWT) | `PUT /projects/:id/hooks/:hook_id` (re-enable) |

---

## 3. Data model (backend)

New app **`apps/integrations`**. It has the standard layering plus:

- `providers/{base,github,gitlab,fake}.py`, `http.py`, `crypto.py`, `matching.py`, `processor.py`,
  `automation.py`, `runner.py`, `tasks.py`;
- `management/commands/{process_integrations,purge_integrations,rotate_integration_secrets,fake_webhook}.py`.

Every model extends `apps.common.models.BaseModel` (UUID primary key, timestamps) unless stated otherwise.

### 3.1 `integrations.Integration`: one connection = one GitHub installation or one GitLab credential

| Field | Type | Notes |
|---|---|---|
| `workspace` | FK `workspaces.Workspace`, CASCADE, `related_name="integrations"` | |
| `provider` | `CharField(8)`, choices `github`, `gitlab` | |
| `auth_kind` | `CharField(16)`, choices `github_app`, `gitlab_oauth`, `gitlab_token` | |
| `base_url` | `CharField(200)` | normalised origin: `https://github.com`, `https://gitlab.com`, `https://gitlab.example.com` (no path, no trailing slash) |
| `account_external_id` | `CharField(64)` | GitHub installation id; GitLab user id of the token or OAuth user |
| `account_login` | `CharField(100)` | GitHub org/user login; GitLab username |
| `account_kind` | `CharField(16)` | `organization`, `user`, `bot` |
| `account_url` | `CharField(300)` | e.g. `https://github.com/platform-team` |
| `status` | `CharField(16)`, choices `pending`, `active`, `error`, `disconnecting` | `pending` = callback done, waiting for confirm (§5.3); never listed |
| `error_code` | `CharField(32, blank)` | `token_expired`, `token_revoked`, `installation_suspended`, `installation_removed`, `insufficient_scope`, `unreachable`, `webhook_failing` |
| `error_since` | `DateTimeField(null)` | |
| `credentials` | `TextField(blank)` | **encrypted JSON** (§10.2). GitHub: `{ "installationToken", "expiresAt" }` (cache only). GitLab OAuth: `{ "accessToken", "refreshToken", "expiresAt" }`. Token mode: `{ "token" }`. |
| `webhook_secret` | `TextField(blank)` | **encrypted**; GitLab only (GitHub uses the app-level secret) |
| `token_expires_at` | `DateTimeField(null)` | GitLab token mode (from `/personal_access_tokens/self`); OAuth refresh token never expires |
| `scopes` | `JSONField(default=list)` | as reported by the provider; checked at connect |
| `connected_by` | FK user, SET_NULL, null | |
| `connected_at`, `last_synced_at`, `last_delivery_at` | `DateTimeField(null)` | `last_synced_at` = latest successful sync run **or** processed delivery |
| `sync_requested_at` | `DateTimeField(null)` | throttles "Sync now" (§5.4 G9) |
| `version` | `PositiveIntegerField(default=1)` | bumped by every write; `select_for_update` around token refresh (§7.5) |

Constraints:

- `UniqueConstraint(fields=["provider", "base_url", "account_external_id"], condition=Q(provider="github") & ~Q(status="disconnecting"), name="integration_github_installation_unique")`.
  A GitHub installation belongs to **at most one workspace**, because webhooks route by installation id. A second
  workspace gets `installation_in_use`.
- `UniqueConstraint(fields=["workspace", "provider", "base_url", "account_external_id"], name="integration_unique_per_ws")`.
- `Index(fields=["status", "last_synced_at"], name="integration_catchup")`.

There can be several integrations per workspace and provider: one per GitHub org, or several GitLab instances.

### 3.2 `integrations.Repository`: a repository the integration can see that an admin chose to track

| Field | Type | Notes |
|---|---|---|
| `integration` | FK `Integration`, CASCADE, `related_name="repositories"` | |
| `workspace` | FK, CASCADE | denormalised |
| `external_id` | `CharField(64)` | GitHub repository id; GitLab project id. **Stable across renames.** |
| `full_path` | `CharField(300)` | `platform-team/web`; GitLab `group/sub/project` |
| `owner_path` | `CharField(255)` | `platform-team`; GitLab namespace full path (picker grouping) |
| `name` | `CharField(100)` | |
| `visibility` | `CharField(10)` | `public`, `private`, `internal` |
| `default_branch` | `CharField(255)` | |
| `web_url` | `CharField(300)` | |
| `all_projects` | `BooleanField(default=True)` | §6.4 |
| `projects` | M2M `projects.Project` (through `RepositoryProject`, unique pair) | used only when `all_projects` is false |
| `hook_id` | `CharField(32, blank)` | GitLab project hook id |
| `open_pr_count` | `PositiveIntegerField(default=0)` | "12 open PRs": set by every sync, ±1 by webhooks |
| `sync_state` | `CharField(10)`, choices `idle`, `queued`, `syncing`, `failed` | "paused" is derived from the integration's error |
| `last_synced_at` | `DateTimeField(null)` | |
| `backfilled_at` | `DateTimeField(null)` | first backfill done |
| `archived` | `BooleanField(default=False)` | archived on the provider; no branch creation |

Constraints:

- `UniqueConstraint(fields=["integration", "external_id"], name="repo_unique_per_integration")`;
- `UniqueConstraint(fields=["workspace", "integration__provider"…])` can't be expressed, so the service enforces
  that one provider repository (by `base_url` + `external_id`) is tracked **once per workspace**;
- `Index(fields=["workspace", "full_path"])`.

Repositories exist only while they are tracked. Untracking deletes the row, and its links keep their denormalised
repository fields (§3.3).

### 3.3 `tasks.ExternalLink` (the v1 reserve, extended)

The table has no rows in any environment (no endpoints in v1), so it is altered in place.

| Field | Type | Notes |
|---|---|---|
| `task` | FK `Task`, CASCADE, `related_name="external_links"` | v1 |
| `provider` | `CharField(16)`, choices `github`, `gitlab`, `other` | v1 |
| `type` | `CharField(16)`, choices `pull_request`, `commit`, `branch`, `issue` | v1. A GitLab MR is `pull_request` with provider `gitlab`. `issue` stays reserved and unused. |
| `url` | `URLField(500)` | v1 |
| `external_id` | `CharField(200)` (was 120) | PR: `"<repoExternalId>#<number>"`; commit: full 40-char sha; branch: `"<repoExternalId>:<name>"` |
| `workspace` | FK, CASCADE | **new**, denormalised for scoping and webhook lookups |
| `repository` | FK `integrations.Repository`, SET_NULL, null | **new** |
| `base_url` | `CharField(200)` | **new**; with `repo_external_id`, re-attaches links when the same repository is tracked again |
| `repo_external_id` | `CharField(64)` | **new** |
| `repo_full_path` | `CharField(300)` | **new**; display text that survives a disconnect |
| `number` | `PositiveIntegerField(null)` | PR number / MR iid |
| `title` | `CharField(300, blank)` | PR title; commit subject line (first line, cut to 300) |
| `state` | `CharField(10, blank)` | PR: `open`, `draft`, `merged`, `closed`; branch: `active`, `deleted`; commit: blank |
| `head_branch`, `base_branch` | `CharField(255, blank)` | PR |
| `sha` | `CharField(40, blank)` | PR head sha; commit sha; branch head sha |
| `checks_state` | `CharField(8, blank)` | `passing`, `failing`, `running`, or blank (no checks) |
| `checks` | `JSONField(default=list)` | at most 20: `[{ "name", "state", "durationSec", "url", "startedAt" }]`, keyed by name for the head `sha` |
| `approvals` | `PositiveSmallIntegerField(default=0)` | PR |
| `ahead_by` | `PositiveIntegerField(null)` | branch, vs the default branch |
| `author_login`, `author_name` | `CharField(100, blank)` | |
| `author_user` | FK user, SET_NULL, null | §7.3 author matching |
| `source_created_at`, `source_updated_at` | `DateTimeField(null)` | provider times; `source_updated_at` guards ordering (§7.2) |
| `merged_at`, `closed_at` | `DateTimeField(null)` | PR |
| `link_source` | `CharField(8)`, choices `auto`, `manual`, `created` | `created` = branch created from Lightex |
| `linked_by` | FK user, SET_NULL, null | manual / created |
| `suppressed` | `BooleanField(default=False)` | set by manual unlink of an auto link: hidden, and auto-matching won't bring it back (§6.6) |

Constraints and indexes:

- `UniqueConstraint(fields=["task", "provider", "type", "external_id"], name="external_link_unique")`;
- `Index(fields=["workspace", "provider", "repo_external_id", "type", "external_id"], name="external_link_object")`
  (webhook fan-out: one PR updates every task it links);
- `Index(fields=["workspace", "provider", "repo_external_id", "sha"], name="external_link_sha")` (checks by head sha);
- `Index(fields=["task", "type", "suppressed"], name="external_link_task")`.

A PR that mentions three keys produces **three rows** with the same `external_id`. Updates fan out with one `UPDATE …
WHERE workspace=… AND provider=… AND repo_external_id=… AND type='pull_request' AND external_id=…`. The task panel
reads one task's rows with no joins. Task soft delete keeps its links, and a restore shows them again.

### 3.4 `integrations.ConnectAttempt`: one connect or reconnect round-trip

| Field | Type | Notes |
|---|---|---|
| `workspace`, `user` | FKs, CASCADE | the admin who clicked Connect |
| `provider` | `CharField(8)` | |
| `mode` | `CharField(10)`, choices `connect`, `reconnect` | |
| `integration` | FK `Integration`, CASCADE, null | the reconnect target, or the pending integration after the callback |
| `state_hash` | `CharField(64, unique)` | SHA-256 of the 32-byte `state` sent to the provider |
| `pkce_verifier` | `TextField(blank)` | **encrypted**; GitLab OAuth |
| `installation_id` | `CharField(32, blank)` | GitHub, recorded at the setup leg |
| `confirm_hash` | `CharField(64, blank)` | SHA-256 of the one-time confirm token (§5.3) |
| `status` | `CharField(12)`, choices `started`, `called_back`, `confirmed`, `failed`, `expired` | |
| `error_code` | `CharField(32, blank)` | |
| `expires_at` | `DateTimeField` | `created + 10 min`; reset to `+ 10 min` at callback |

`purge_integrations` expires stale attempts. An attempt that expires while `called_back` **revokes and deletes** its
pending integration.

### 3.5 `integrations.WebhookDelivery`

| Field | Type | Notes |
|---|---|---|
| `provider` | `CharField(8)` | |
| `delivery_id` | `CharField(80)` | `X-GitHub-Delivery`; GitLab `X-Gitlab-Event-UUID`, else `Idempotency-Key`, else `sha256(body)` |
| `integration` | FK, SET_NULL, null | resolved at receipt (GitHub: `installation.id` → integration; GitLab: the path id) |
| `event` | `CharField(40)` | `pull_request`, `push`, `Merge Request Hook`, … |
| `action` | `CharField(40, blank)` | |
| `payload` | `JSONField(null)` | the parsed body; null when it was over the size cap |
| `status` | `CharField(10)`, choices `received`, `processing`, `processed`, `ignored`, `failed` | |
| `attempts` | `PositiveSmallIntegerField(default=0)` | |
| `error` | `CharField(300, blank)` | |
| `lease_token` | `UUIDField(null)` | |
| `locked_at`, `processed_at` | `DateTimeField(null)` | |
| `received_at` | `DateTimeField(default=now)` | |

Constraints and indexes:

- `UniqueConstraint(fields=["provider", "delivery_id"], name="webhook_delivery_idempotent")`;
- `Index(fields=["status", "received_at"], name="webhook_queue")`;
- `Index(fields=["received_at"], name="webhook_retention")`.

Retention: `purge_integrations` deletes rows older than `WEBHOOK_RETENTION_DAYS` (7). Payloads are **never** copied
into audit rows.

### 3.6 `integrations.SyncRun`

| Field | Type | Notes |
|---|---|---|
| `integration` | FK, CASCADE | |
| `repository` | FK, CASCADE, null | null = every tracked repository of the integration |
| `kind` | `CharField(10)`, choices `backfill`, `sync`, `catchup` | §7.4, §7.6 |
| `status` | `CharField(10)`, choices `queued`, `running`, `deferred`, `done`, `failed` | `deferred` = waiting for a rate-limit reset |
| `run_after` | `DateTimeField(default=now)` | |
| `requested_by` | FK user, SET_NULL, null | |
| `lease_token`, `heartbeat_at` | | board 40 lease (§7.3) |
| `stats` | `JSONField(default=dict)` | `{ "requests": 41, "prs": 18, "branches": 6, "commits": 120, "links": 23, "partial": false }` |
| `error` | `CharField(300, blank)` | |
| `started_at`, `finished_at` | `DateTimeField(null)` | |

Constraint: `UniqueConstraint(fields=["integration", "repository"], condition=Q(status__in=["queued", "running", "deferred"]), name="sync_one_active")`.
A second request while one is active returns the existing run.

### 3.7 `integrations.AutomationRule`

| Field | Type | Notes |
|---|---|---|
| `project` | FK `projects.Project`, CASCADE, `related_name="dev_rules"` | |
| `trigger` | `CharField(16)`, choices `branch_created`, `pr_opened`, `pr_merged` | |
| `status` | FK `projects.Status`, CASCADE | target status |
| `enabled` | `BooleanField(default=True)` | |
| `updated_by` | FK user, SET_NULL, null | |

Constraint: `UniqueConstraint(fields=["project", "trigger"])`. With no row, the trigger does nothing. **Every rule is
off by default** (§13 #4).

### 3.8 Migrations

- `integrations` 0001: all models above. Add `apps.integrations` to `INSTALLED_APPS` and its URLs to
  `config/api_urls.py`.
- `tasks` 000N (next free number): alter `ExternalLink` as in §3.3 and add the indexes. No data migration.
- `audit` 000N: `AuditLog.actor_kind` `CharField(12, default="user")` and `AuditLog.actor_ref`
  `CharField(64, blank)`. `actor_ref` holds the integration id for integration actors. Also add
  `Index(fields=["workspace", "actor_ref", "-created_at"], condition=~Q(actor_ref=""))`.
- `access` 00NN (data, idempotent; the next number after boards 39, 40 and 33): create `integration.manage` and
  `development.link` if they are missing, and add them to existing **system** roles by `system_key` (§4.2). Custom
  roles are untouched. Reverse = no-op.
- `Project.devEnabled` and `Task.dev` are computed, not stored.

---

## 4. Permissions

### 4.1 New catalogue entries

| Code | Scope | Group | Label | Description |
|---|---|---|---|---|
| `integration.manage` | workspace | Administration | Manage integrations | Connect GitHub and GitLab, choose repositories and disconnect |
| `development.link` | project | Tasks | Link code | Create branches and link or unlink pull requests, commits and branches |

**What needs no new key:**

| Action | Rule |
|---|---|
| See the Integrations page, the connections and their status | `workspace.view` (every member, as in the design). Repositories mapped to projects you can't view are left out (§5.4 G1). |
| See a task's Development section and the board PR chip | `project.view` on the task's project |
| Edit automation rules (project settings → Development) | `status.manage` (they are workflow rules) |

**Why these scopes.** Connections are workspace-wide credentials, and workspace and project scopes never override
each other. A Project Admin therefore can't connect an org, and a workspace Admin who isn't on PRJ can't create a
branch from a PRJ task.

Placement:

- `backend/apps/access/catalogue.py` `PERMISSIONS`: `integration.manage` after `workspace.manage_roles`;
  `development.link` after `task.move` (after board 40's `project.import` once that is present).
- `WORKSPACE_ORDER`: after `project.assign_admin`, before `audit.view`.
- `PROJECT_ORDER`: after `project.import`, before `time.log`.
- Mirror all of it in `frontend/src/lib/permissions/catalogue.ts`, `WORKSPACE_PERMISSIONS` and
  `PROJECT_PERMISSIONS` (`types.ts`).

### 4.2 Default roles

| Role | integration.manage | development.link |
|---|---|---|
| Owner (workspace) | ✓ (core: stays `list(WORKSPACE_ORDER)`) | — |
| Admin (workspace) | ✓ (stays "WORKSPACE_ORDER minus workspace.delete"; **not** core) | — |
| Member (workspace) | — | — |
| Project Admin | — | ✓ (core: stays `list(PROJECT_ORDER)`) |
| Manager | — | ✓ (stays "PROJECT_ORDER minus archive/delete/manage_members") |
| Member (`project_member`) | — | ✓ (add `"development.link"` after `task.move` / `project.import` in its explicit list) |
| Viewer | — | — |

### 4.3 `my_permissions` order

`WORKSPACE_ORDER` / `WORKSPACE_PERMISSIONS` become:

```
workspace.view, workspace.update, workspace.delete, workspace.manage_members, workspace.manage_roles,
project.create, project.assign_admin, integration.manage, audit.view
```

`PROJECT_ORDER` / `PROJECT_PERMISSIONS` become (including boards 39, 40 and 33):

```
project.view, project.update, project.archive, project.delete, project.manage_members,
objective.manage, milestone.manage, epic.manage, sprint.manage, status.manage, field.manage,
task.create, task.edit_any, task.edit_own, task.delete, task.assign, task.move, project.import, development.link,
time.log, time.delete_any,
comment.create, comment.edit_own, comment.delete_any, attachment.upload, attachment.delete_any,
dashboard.create, dashboard.manage,
report.view
```

Example for Sam (project Member on PRJ):
`["project.view","task.create","task.edit_own","task.assign","task.move","project.import","development.link","time.log","comment.create","comment.edit_own","attachment.upload","dashboard.create","report.view"]`.

### 4.4 Object rules

| Action | Rule |
|---|---|
| Read an integration (G1, G6) | workspace member (non-members get 404) |
| Write an integration (G2–G5, G7–G12) | `integration.manage` on the integration's workspace, checked again at confirm (§5.3) |
| Development panel (D1) | `project.view` on the task's project (v1 task resolution: 404 / 403 `project_membership_required`) |
| Link / unlink / create branch (D2–D4) | `development.link` on the task's project, **and** the repository is tracked in the task's workspace and applies to the task's project (§6.4). Otherwise 422 `repository_not_for_project`. |
| Automation rules (A1 / A2) | `project.view` / `status.manage` |
| Webhook receivers | no user. Signature or secret only (§7.1). |

---

## 5. Endpoints

Every path is under `/api/v1`. Views declare `required = {METHOD: code}` as in v1, plus the object rules in §4.4.

### 5.0 Summary

| # | Method | Path | Permission | Response |
|---|---|---|---|---|
| G1 | GET | `/workspaces/:slug/integrations` | member | 200 `IntegrationsOverview` |
| G2 | POST | `/workspaces/:slug/integrations/github/connect` | `integration.manage` | 200 `{ authorizeUrl }` |
| G3 | POST | `/workspaces/:slug/integrations/gitlab/connect` | `integration.manage` | 200 `{ authorizeUrl }` (OAuth) · 201 `Integration` (token) |
| G4 | GET | `/integrations/github/setup` | browser, `state` | 302 |
| G5 | GET | `/integrations/github/callback` · `/integrations/gitlab/callback` | browser, `state` | 302 |
| G6 | POST | `/workspaces/:slug/integrations/confirm` | `integration.manage` | 200 `Integration` |
| G7 | GET | `/integrations/:id` | member | 200 `Integration` |
| G8 | GET | `/integrations/:id/available-repositories?q=` | `integration.manage` | 200 `AvailableRepository[]` |
| G9 | PUT | `/integrations/:id/repositories` | `integration.manage` | 200 `Integration` |
| G10 | PATCH | `/repositories/:id` | `integration.manage` | 200 `Repository` |
| G11 | POST | `/integrations/:id/sync` | `integration.manage` | 202 `Integration` |
| G12 | POST | `/integrations/:id/reconnect` | `integration.manage` | 200 `{ authorizeUrl }` · 200 `Integration` (token) |
| G13 | DELETE | `/integrations/:id` | `integration.manage` | 204 |
| W1 | POST | `/webhooks/github` | HMAC | 202 / 200 / 401 |
| W2 | POST | `/webhooks/gitlab/:integrationId` | `X-Gitlab-Token` | 202 / 200 / 401 / 404 |
| D1 | GET | `/tasks/:id/development` | `project.view` | 200 `TaskDevelopment` |
| D2 | POST | `/tasks/:id/development/links` | `development.link` | 201 `DevItem` |
| D3 | DELETE | `/tasks/:id/development/links/:linkId` | `development.link` | 204 |
| D4 | POST | `/tasks/:id/development/branches` | `development.link` | 201 `DevBranch` |
| A1 | GET | `/projects/:id/dev-automation` | `project.view` | 200 `AutomationRule[]` |
| A2 | PUT | `/projects/:id/dev-automation` | `status.manage` | 200 `AutomationRule[]` |

`:id` in D1–D4 is a task id or key, as in v1 `tasks/{idOrKey}`.

**Additive payload changes:**

- Every `Task` payload gains `dev` (§5.7).
- Every `Project` payload gains `devEnabled: boolean`: at least one `active` integration has a tracked repository
  that applies to this project.
- `ActivityEntry` gains `actorName: string | null` and `actorKind: "user" | "integration"`.
- `AuditEntry.source` gains `"webhook"`; `actorKind: "integration"` is now actually emitted (it was declared on the
  frontend in v1).
- `Notification.payload` gains `via?: "github" | "gitlab"` (§8.3).
- `ActivityVerb` gains `dev_linked`, `dev_branch_created` and `dev_pr_merged`.
- `GET /permissions` returns both new keys.

### 5.1 Shapes

```ts
type Provider = "github" | "gitlab";
type IntegrationErrorCode =
  | "token_expired" | "token_revoked" | "installation_suspended" | "installation_removed"
  | "insufficient_scope" | "unreachable" | "webhook_failing";

interface ProviderInfo {
  provider: Provider;
  name: "GitHub" | "GitLab";
  available: boolean;                       // server configured (§2.3)
  methods: ("app" | "oauth" | "token")[];   // github: ["app"]; gitlab: ["oauth","token"] or ["token"]
  oauthBaseUrl: string | null;              // gitlab oauth: "https://gitlab.com"
  canCreateBranch: boolean;                 // GITHUB_BRANCH_CREATION for github; true for gitlab
}

interface Integration {
  id: ID;
  provider: Provider;
  authKind: "github_app" | "gitlab_oauth" | "gitlab_token";
  baseUrl: string;
  account: { login: string; kind: "organization" | "user" | "bot"; url: string };
  status: "active" | "error";
  error: { code: IntegrationErrorCode; message: string; since: ISODateTime } | null;
  connectedBy: ID | null;
  connectedAt: ISODateTime;
  lastSyncedAt: ISODateTime | null;
  syncing: boolean;                         // a SyncRun is queued/running/deferred
  nextSyncAt: ISODateTime | null;           // "Sync now" available again at (§5.4 G11)
  tokenExpiresAt: ISODateTime | null;
  manageUrl: string | null;                 // GitHub: installation settings; GitLab token: null
  repositories: Repository[];               // tracked only; ordered by full path
}

interface Repository {
  id: ID;
  integrationId: ID;
  provider: Provider;
  externalId: string;
  fullPath: string;          // "platform-team/web"
  owner: string;             // "platform-team"
  name: string;              // "web"
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
  url: string;
  allProjects: boolean;
  projectIds: ID[];          // [] when allProjects
  openPullRequests: number;
  syncState: "idle" | "queued" | "syncing" | "paused" | "failed";   // "paused" when the integration is in error
  lastSyncedAt: ISODateTime | null;
  canCreateBranch: boolean;  // provider allows it and the repository isn't archived
}

interface AvailableRepository {
  externalId: string;
  fullPath: string;
  owner: string;
  name: string;
  visibility: "public" | "private" | "internal";
  updatedAt: ISODateTime | null;   // pushed_at / last_activity_at → "2m"
  tracked: boolean;                // tracked by this integration
  trackedElsewhere: boolean;       // tracked by another integration in this workspace (disabled row)
}

interface IntegrationsOverview {
  providers: ProviderInfo[];       // always both, github first
  integrations: Integration[];     // active + error; ordered github first, then connectedAt
}
```

### 5.2 G1 `GET /workspaces/:slug/integrations`

```json
{
  "providers": [
    { "provider": "github", "name": "GitHub", "available": true, "methods": ["app"], "oauthBaseUrl": null, "canCreateBranch": true },
    { "provider": "gitlab", "name": "GitLab", "available": true, "methods": ["oauth", "token"], "oauthBaseUrl": "https://gitlab.com", "canCreateBranch": true }
  ],
  "integrations": [
    {
      "id": "6f1c0d7e-…",
      "provider": "github",
      "authKind": "github_app",
      "baseUrl": "https://github.com",
      "account": { "login": "platform-team", "kind": "organization", "url": "https://github.com/platform-team" },
      "status": "active",
      "error": null,
      "connectedBy": "u-alex…",
      "connectedAt": "2026-10-02T10:14:00Z",
      "lastSyncedAt": "2026-10-09T08:58:00Z",
      "syncing": false,
      "nextSyncAt": null,
      "tokenExpiresAt": null,
      "manageUrl": "https://github.com/organizations/platform-team/settings/installations/51234567",
      "repositories": [
        {
          "id": "a1…", "integrationId": "6f1c0d7e-…", "provider": "github", "externalId": "712004001",
          "fullPath": "platform-team/web", "owner": "platform-team", "name": "web", "visibility": "private",
          "defaultBranch": "main", "url": "https://github.com/platform-team/web",
          "allProjects": true, "projectIds": [], "openPullRequests": 12,
          "syncState": "idle", "lastSyncedAt": "2026-10-09T08:58:00Z", "canCreateBranch": true
        }
      ]
    }
  ]
}
```

- **Error example** (design "Token expired"):
  `"status": "error", "error": { "code": "token_expired", "message": "GitLab access expired. Reconnect to resume syncing.", "since": "2026-10-06T09:00:00Z" }`.
  Each repository then has `"syncState": "paused"`.
- **Non-managers** (no `integration.manage`) get the same payload, except that `repositories` leaves out repositories
  whose `allProjects` is false and that map to none of the caller's viewable projects, and `manageUrl` is `null`.
- Side effect: if an `active` integration's `lastSyncedAt` is older than `INTEGRATION_CATCHUP_MINUTES`, G1 enqueues
  a `catchup` run (§7.6). This is idempotent through `sync_one_active`. The response doesn't wait for it.

### 5.3 Connect and reconnect

**Why there is no cookie.** The client keeps the access token in memory, so the provider's browser redirect back to
the API can't authenticate. The Google sign-in flow carries its state in a cookie scoped to the API, but here the
client and API are on different sites in production (`REFRESH_COOKIE_SAMESITE=None`), and Safari's ITP drops cookies
set by a cross-site `fetch`. This flow therefore binds the round-trip with **two secrets**:

- the `state` (stored hashed in `ConnectAttempt`);
- a **one-time confirm token** returned in the **URL fragment**, which the authenticated client must send back.

The attacker case: an attacker who starts a flow and tricks a victim into authorizing it never sees the confirm
token, and the victim can't confirm because the attempt belongs to the attacker's user.

#### G2 `POST /workspaces/:slug/integrations/github/connect`

Body: `{}`. Throttle: `integration_connect`.

1. Check `integration.manage` and that the provider is available (else 503 `integrations_unavailable`).
2. Create a `ConnectAttempt(mode="connect")` with `state = secrets.token_urlsafe(32)`, storing only its hash.
3. Respond **200**: `{ "authorizeUrl": "https://github.com/apps/lightex/installations/new?state=Qm9…" }`

The client sets `window.location.href = authorizeUrl` (§9.6). **Installing on another org** uses the same endpoint;
GitHub's install page offers every account the user can install on.

#### G3 `POST /workspaces/:slug/integrations/gitlab/connect`

| Body | Result |
|---|---|
| `{ "method": "oauth" }` | 200 `{ "authorizeUrl": "https://gitlab.com/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&scope=api&state=…&code_challenge=…&code_challenge_method=S256" }` (PKCE verifier stored encrypted on the attempt) |
| `{ "method": "token", "baseUrl": "https://gitlab.example.com", "token": "glpat-…" }` | Synchronous: SSRF-check `baseUrl` (§10.4) → `GET /api/v4/personal_access_tokens/self` (must be `active`, scopes ⊇ `api`) → `GET /api/v4/user` → create an `active` integration. **201** `Integration` with `repositories: []`. The client then opens the picker. |

Errors (token method), each as 422 `validation_failed` with the field named:

| Field | Message |
|---|---|
| `baseUrl` | "Use an https:// address." / "This address isn't allowed." (SSRF) / "Couldn't reach GitLab at this address." |
| `token` | "GitLab didn't accept this token." / "The token needs the api scope." / "This token has expired." |

409 `integration_exists` when this workspace already has this GitLab user on this instance, with
`details.integrationId` (the client offers "Reconnect" instead).

#### G4 `GET /integrations/github/setup?installation_id=…&setup_action=install|update|request&state=…`

Browser navigation; `AnonymousView`.

1. Look up the attempt by `sha256(state)`. It must be `started` and not expired; otherwise redirect with
   `error=state_invalid`.
2. `setup_action=request`: an org member asked their owner to approve. Mark the attempt `failed`
   (`github_requested`) and redirect.
3. Otherwise store `installation_id` and **302** to
   `https://github.com/login/oauth/authorize?client_id=<GITHUB_APP_CLIENT_ID>&redirect_uri=<callback>&state=<same state>`.

#### G5 `GET /integrations/{github|gitlab}/callback?code=…&state=…` (or `?error=access_denied&state=…`)

Browser navigation; `AnonymousView`.

1. Look up the attempt (as in G4). If the user, workspace or permission no longer resolves, fail with
   `state_invalid`.
2. Exchange the code. GitHub: verify the installation (§2.1), revoke the user token, read the installation
   (`GET /app/installations/{id}` with the app JWT) for the account login and kind. GitLab: token response and
   `GET /user`.
3. Find or create the integration:
   - **connect**:
     - GitHub installation already claimed by another workspace → fail `installation_in_use`;
     - already connected in this workspace → reuse it (an "update" flow; repository access may have changed);
     - otherwise create it with `status="pending"`.
   - **reconnect**: the account must match the target (`account_external_id`), else fail `account_mismatch`. Then
     store the new credentials, still `pending`.
4. Generate `confirm = secrets.token_urlsafe(32)` and store `confirm_hash`. Set the attempt to `called_back` and
   `expires_at` to now + 10 min.
5. **302** → `<FRONTEND_URL>/<slug>/settings/integrations#connect=<attemptId>.<confirm>`.

Failures **302** → `<FRONTEND_URL>/<slug>/settings/integrations#connect_error=<code>`, or
`<FRONTEND_URL>/#connect_error=state_invalid` when the workspace can't be resolved. The codes and their client copy:

| Code | Copy |
|---|---|
| `github_cancelled` / `gitlab_cancelled` | "Connection cancelled." (info, no error tone) |
| `github_requested` | "Installation requested. An owner of the GitHub organization has to approve it; then connect again." |
| `installation_in_use` | "This GitHub account is already connected to another Lightex workspace." |
| `account_mismatch` | "Reconnect with the same account that was connected before." |
| `insufficient_scope` | "Lightex needs the api scope (GitLab) or the requested permissions (GitHub)." |
| `state_invalid` | "That connection link expired. Try again." |
| `provider_failed` | "GitHub didn't respond. Try again in a minute." (or GitLab) |

#### G6 `POST /workspaces/:slug/integrations/confirm`

Body: `{ "attempt": "<attemptId>", "token": "<confirm>" }`.

The server checks, in order:

- the attempt belongs to this workspace;
- `attempt.user == request.user`;
- `compare_digest(sha256(token), confirm_hash)`;
- the attempt is `called_back` and not expired;
- the caller holds `integration.manage`.

Any mismatch returns 404 `not_found` (so nothing is revealed). On success:

1. integration → `active`, attempt → `confirmed`;
2. audit `integration.connected` (or `integration.reconnected`);
3. for a reconnect, the integration's error is cleared and a `catchup` run is enqueued.

Response **200** `Integration`. A new connection has `repositories: []`, or the tracked set when the installation
was already connected. The client then:

- opens **Choose repositories** for `connect`;
- shows the toast "GitHub reconnected" for `reconnect`.

#### G12 `POST /integrations/:id/reconnect`

| Integration | Body | Result |
|---|---|---|
| GitHub (`installation_removed`, `installation_suspended`, `insufficient_scope`) | `{}` | 200 `{ authorizeUrl }` (install/configure page; same G4/G5 legs, `mode=reconnect`) |
| GitLab OAuth (`token_expired`/`token_revoked`) | `{}` | 200 `{ authorizeUrl }` |
| GitLab token | `{ "token": "glpat-…" }` | synchronous checks as in G3 (same user id required, else 422 `token: "This token belongs to a different GitLab user."`) → 200 `Integration`, error cleared |

### 5.4 Repositories, sync, disconnect

#### G8 `GET /integrations/:id/available-repositories?q=web`

Fetched live from the provider (§2.4), cached for 60 s per integration in the Django cache, and capped at 1,000
repositories. `q` filters case-insensitively by `fullPath`, in memory. Results are sorted by `owner`, then `name`.

```json
[
  { "externalId": "712004001", "fullPath": "platform-team/web", "owner": "platform-team", "name": "web", "visibility": "private", "updatedAt": "2026-10-09T08:57:00Z", "tracked": true, "trackedElsewhere": false },
  { "externalId": "712004188", "fullPath": "platform-team/infra-terraform", "owner": "platform-team", "name": "infra-terraform", "visibility": "private", "updatedAt": "2026-10-08T09:00:00Z", "tracked": false, "trackedElsewhere": false }
]
```

Errors:

- 502 `provider_failed` "GitHub didn't respond. Try again." (the picker shows its error state with Retry);
- 409 `integration_error` while the integration is in error (`details.code`).

A GitHub picker lists only what the **installation** can see. Its footer links to `Integration.manageUrl`: "Missing a
repository? Change access on GitHub". A GitLab picker lists projects where the credential is Maintainer or above.

#### G9 `PUT /integrations/:id/repositories`

```json
{ "repositories": [ { "externalId": "712004001" }, { "externalId": "712004002", "projectIds": ["5f0e…"] } ] }
```

The body is the **complete tracked set**: 1–200 items. An empty list returns 422
`repositories: "Choose at least one repository."`, because disconnecting is a separate action. Each item:

- `projectIds` omitted or `[]` → `allProjects = true`;
- otherwise the ids must be projects of the workspace.

The service then:

1. Rejects ids that the integration can't see (live list, cache bypassed) and ids already tracked by another
   integration of the workspace: 422 `repositories.<i>.externalId`.
2. **Added** repositories: create `Repository` rows. GitLab: `enable_repository` creates the hook (failure → the
   whole call fails with 502 `provider_failed`, `details.repository`, and nothing is saved). Then enqueue a
   `backfill` run per added repository (§7.4).
3. **Removed** repositories: GitLab hook deleted (best-effort), `Repository` row deleted. Its links stay, with
   `repository` set to NULL.
4. Re-attach orphaned links of added repositories (same `base_url` + `repo_external_id`).
5. Audit `integration.repositories_updated` with `data: { added: [paths], removed: [paths] }`. Publish
   `integration.changed` (§8.4).

Response **200** `Integration`, with `syncState: "queued"` on the added repositories. Toast: "GitHub connected · 4
repos" (first save after connect) / "Repositories updated".

#### G10 `PATCH /repositories/:id`

Body: `{ "projectIds": ["5f0e…"] }` or `{ "projectIds": [] }` (= all projects). Response 200 `Repository`. Audit
`integration.repository_scoped` with `data: { repository, projects: ["PRJ"] | "all" }`.

#### G11 `POST /integrations/:id/sync` ("Sync now")

- Enqueues a `sync` run for every tracked repository: **202** `Integration` with `syncing: true`.
- Allowed once per **2 minutes** per integration: otherwise 429 `sync_throttled` with `Retry-After` and
  `details.nextSyncAt`.
- An integration in error → 409 `integration_error`.

#### G13 `DELETE /integrations/:id` (Disconnect)

Within one transaction:

- status → `disconnecting`;
- the integration's received/processing webhook deliveries → `ignored`;
- its active sync runs → `failed` (`disconnected`);
- every repository's `ExternalLink.repository` → NULL;
- audit `integration.disconnected`;
- `integration.changed` op `disconnected`.

Respond **204** immediately. After commit, the runner revokes on the provider (§7.9), wipes `credentials` and
`webhook_secret`, and **deletes** the integration and its repositories. Links stay on tasks, as the design promises.
`Project.devEnabled` becomes false where no other integration covers the project. The Development section then still
renders when a task has links (§9.5).

### 5.5 Webhook receivers

`authentication_classes = []`, `permission_classes = [AllowAny]`, CSRF-exempt (DRF `APIView` without session
auth), throttle scope `webhook` (1200/min per IP), never the default `anon` throttle. Both views:

1. Reject requests whose `Content-Length` is over `WEBHOOK_MAX_BODY_BYTES`, or with no `Content-Length`: **413**
   `payload_too_large`. Read exactly `Content-Length` bytes from `request` (not `request.body`, so Django's
   `DATA_UPLOAD_MAX_MEMORY_SIZE` doesn't interfere).
2. **Verify** (§10.1). A failure returns **401** `invalid_signature` with no other detail, and the failure is counted
   in a log metric.
3. Parse JSON (failure → 400 `bad_request`). Resolve the integration (below).
4. `INSERT … ON CONFLICT (provider, delivery_id) DO NOTHING`. If nothing was inserted: **200**
   `{ "received": true, "duplicate": true }`.
5. Respond **202** `{ "received": true }` and dispatch processing on commit (§7.3). **No provider API call and no
   task write happens inside the request.**

#### W1 `POST /webhooks/github`

| Header | Use |
|---|---|
| `X-Hub-Signature-256: sha256=<hex>` | HMAC-SHA256 of the raw body with `GITHUB_WEBHOOK_SECRET` |
| `X-GitHub-Delivery` | `delivery_id` |
| `X-GitHub-Event` | `event` (`ping` → 200 `{ "received": true }` without storing) |
| `X-GitHub-Hook-Installation-Target-ID` | app id; must equal `GITHUB_APP_ID`, else 202 + `ignored` |

The integration is resolved from `payload.installation.id`. If no integration owns that installation, the delivery
is stored as `ignored`. That happens after a disconnect, or for installations that were never confirmed. **An
`installation.deleted` event for an unknown installation is ignored too.**

#### W2 `POST /webhooks/gitlab/:integrationId`

| Header | Use |
|---|---|
| `X-Gitlab-Token` | compared with the integration's decrypted `webhook_secret` |
| `X-Gitlab-Event` | `Push Hook`, `Merge Request Hook`, `Pipeline Hook` (anything else → stored `ignored`) |
| `X-Gitlab-Event-UUID` / `Idempotency-Key` | `delivery_id` (fallback `sha256(body)`) |
| `X-Gitlab-Instance` | must equal the integration's `base_url` host, else 401 |

Responses:

- unknown or `disconnecting` integration id → **404** `not_found`, so GitLab's auto-disable eventually stops a hook
  whose deletion failed;
- integration in `error` → 202, and the delivery is stored and processed (webhooks don't need our token);
- `payload.project.id` not tracked → stored `ignored`.

### 5.6 Task development

#### D1 `GET /tasks/:id/development`

```json
{
  "taskId": "7a3b…",
  "taskKey": "PRJ-42",
  "enabled": true,
  "suggestedBranch": "prj-42-fix-flaky-board-reflow",
  "repositories": [
    { "id": "a1…", "provider": "github", "fullPath": "platform-team/web", "name": "web", "defaultBranch": "main", "canCreateBranch": true },
    { "id": "a2…", "provider": "github", "fullPath": "platform-team/api", "name": "api", "defaultBranch": "main", "canCreateBranch": true }
  ],
  "pullRequests": [
    {
      "id": "lnk_1…", "kind": "pull_request", "provider": "github",
      "repository": { "id": "a1…", "fullPath": "platform-team/web" },
      "number": 214, "ref": "#214",
      "title": "PRJ-42 Fix flaky board reflow",
      "url": "https://github.com/platform-team/web/pull/214",
      "state": "open",
      "headBranch": "prj-42-fix-reflow", "baseBranch": "main",
      "author": { "login": "akim", "name": "Alex Kim", "userId": "u-alex…" },
      "checks": {
        "state": "failing", "passed": 1, "total": 3,
        "items": [
          { "name": "e2e / board-drag", "state": "failing", "durationSec": 134, "url": "https://github.com/platform-team/web/runs/1" },
          { "name": "unit / reflow", "state": "failing", "durationSec": 48, "url": "…" },
          { "name": "lint", "state": "passing", "durationSec": 12, "url": "…" }
        ]
      },
      "approvals": 0,
      "linkSource": "auto",
      "createdAt": "2026-10-08T15:00:00Z", "updatedAt": "2026-10-09T08:40:00Z",
      "mergedAt": null, "closedAt": null
    },
    {
      "id": "lnk_4…", "kind": "pull_request", "provider": "github",
      "repository": { "id": "a1…", "fullPath": "platform-team/web" },
      "number": 190, "ref": "#190", "title": "PRJ-42 Drop will-change hack", "url": "…",
      "state": "closed", "headBranch": "prj-42-will-change", "baseBranch": "main",
      "author": { "login": "akim", "name": "Alex Kim", "userId": "u-alex…" },
      "checks": null, "approvals": 0, "linkSource": "auto",
      "createdAt": "2026-10-03T10:00:00Z", "updatedAt": "2026-10-04T10:00:00Z", "mergedAt": null, "closedAt": "2026-10-04T10:00:00Z"
    }
  ],
  "branches": [
    {
      "id": "lnk_b1…", "kind": "branch", "provider": "github",
      "repository": { "id": "a1…", "fullPath": "platform-team/web" },
      "name": "prj-42-fix-reflow", "url": "https://github.com/platform-team/web/tree/prj-42-fix-reflow",
      "state": "active", "aheadBy": 3, "linkSource": "auto", "updatedAt": "2026-10-09T08:00:00Z"
    }
  ],
  "commits": [
    {
      "id": "lnk_c1…", "kind": "commit", "provider": "github",
      "repository": { "id": "a1…", "fullPath": "platform-team/web" },
      "sha": "a3f9c21d6e…", "shortSha": "a3f9c21",
      "message": "fix(board): debounce reflow (PRJ-42)",
      "url": "https://github.com/platform-team/web/commit/a3f9c21d6e…",
      "author": { "login": "akim", "name": "Alex Kim", "userId": "u-alex…" },
      "committedAt": "2026-10-09T08:00:00Z", "linkSource": "auto"
    }
  ],
  "commitTotal": 4,
  "syncedAt": "2026-10-09T08:58:00Z"
}
```

| Field | Rule |
|---|---|
| `enabled` | `Project.devEnabled` |
| `repositories` | Tracked repositories that apply to this project, from `active` integrations, ordered by full path. The Create-branch select lists those with `canCreateBranch`. |
| `pullRequests` | Not suppressed. Ordered: `open` and `draft` first, by `updatedAt` desc; then `merged` by `mergedAt` desc; then `closed`. Max 50. |
| `branches` | Not suppressed, `state = active` (deleted branches are hidden but kept, because a PR may still name them). By `updatedAt` desc. Max 50. |
| `commits` | Not suppressed. By `committedAt` desc. Max 20 (`commitTotal` gives the full count; the panel shows "Show all 34 on GitHub" only when the commits are in one repository). |
| `ref` | GitHub `#214`, GitLab `!12` (MR iid convention). |
| `checks` | `null` when there are no checks for the head sha. `state` is aggregated as **failing > running > passing** (§7.2). |
| `author.userId` | §7.3 author matching. `null` → the client shows initials and a hue hashed from `login` (§9.7). |
| `repository` | `null` after a disconnect. Then `repoFullPath` is still present on every item (not shown above; every item carries `"repoFullPath": "platform-team/web"`). |

Opening D1 does **not** call the provider. When the integration's `lastSyncedAt` is older than
`INTEGRATION_CATCHUP_MINUTES`, it enqueues a `catchup` run, as G1 does.

#### D2 `POST /tasks/:id/development/links`

Body: `{ "url": "https://github.com/platform-team/web/pull/214" }`. Throttle: `dev_link`.

Accepted URL forms. A trailing slash, `/files`, `/commits`, `/diffs` or `#…` is ignored.

| Provider | PR/MR | Commit | Branch |
|---|---|---|---|
| GitHub | `https://github.com/{owner}/{repo}/pull/{n}` | `…/commit/{sha7-40}` | `…/tree/{branch}` |
| GitLab | `{baseUrl}/{namespace…}/{project}/-/merge_requests/{iid}` | `…/-/commit/{sha}` | `…/-/tree/{branch}` |

The service:

1. Matches a tracked repository of the workspace by base URL and full path. No match → 422
   `url: "Connect this repository first."`. A repository that doesn't apply to this project → 422
   `url: "This repository isn't used by PRJ."`.
2. Calls `resolve_url` on the provider: 404 → 422 `url: "GitHub can't find this pull request."`; provider down → 502
   `provider_failed`.
3. Upserts the link with `link_source="manual"`, `suppressed=false` and `linked_by`. An existing row with the same
   object has its suppression lifted (re-link). An already-visible link → 200 with that `DevItem` instead of 201.
4. Audits `task.dev_linked` (§8.1).

Response **201** `DevItem` (`DevPullRequest | DevBranch | DevCommit`, as in D1).

#### D3 `DELETE /tasks/:id/development/links/:linkId`

- `manual` link → the row is deleted.
- `auto` / `created` link → `suppressed = true` (§6.6).

Either way: audit `task.dev_unlinked`, **204**. Unlinking a PR doesn't touch the PR's other tasks.

#### D4 `POST /tasks/:id/development/branches`

```json
{ "repositoryId": "a1…", "name": "prj-42-fix-flaky-board-reflow" }
```

Throttle: `dev_branch`. The service:

1. Validates the name (§6.3): 422 `name` "Use letters, numbers, - _ . / only." / "Branch names can't contain '..'." /
   "Up to 80 characters."
2. Checks the repository: it must apply to the project and have `canCreateBranch`, else 422 `repositoryId`.
3. Creates the branch from the repository's **default branch** (the design's "from main in"). An existing branch →
   409 `branch_exists` "That branch already exists in platform-team/web." The provider rejecting it (protected
   pattern, permissions) → 422 `name` with the provider's message cut to 200 characters.
4. Creates `ExternalLink(type=branch, link_source="created", linked_by=user)`. **The branch is linked even if its
   name has no task key.**
5. Audits `task.dev_branch_created` and runs the `branch_created` automation (§7.10). When the push event later
   arrives, it updates the same row (same `external_id`).

Response **201** `DevBranch`, with `aheadBy: 0` and `updatedAt` = now. Flash: "Branch created".

### 5.7 `Task.dev` (board, list, backlog, task, my tasks, workspace tasks, search, bulk, PATCH/move responses)

```ts
dev: {
  pr: {
    provider: Provider;
    number: number;
    ref: string;                 // "#214" | "!12"
    state: "open" | "draft" | "merged" | "closed";
    checks: "passing" | "failing" | "running" | null;
    checksPassed: number;
    checksTotal: number;
    approvals: number;
    baseBranch: string;
    mergedAt: ISODateTime | null;
  } | null;                       // the headline PR (rule below)
  prCount: number;
  branchCount: number;
  commitCount: number;
} | null                          // null when the task has no visible links
```

The **headline PR** is the most recently updated `open`/`draft` PR. If there is none, it is the most recently
merged PR merged within the last 14 days. Otherwise it is `null`; closed PRs never headline. This drives the board
chip (§9.5).

The board, list and backlog keep a **constant query count**: one `Prefetch("external_links",
queryset=visible_pr_links, to_attr=…)` plus `Count(... filter=…)` annotations per type in `tasks.selectors.annotated()`.
The task `version` is **not** bumped by link changes, as with board 39 dependencies.

### 5.8 Automation rules (project settings → Development)

#### A1 `GET /projects/:id/dev-automation`

The response always lists all three triggers, in this order: `branch_created`, `pr_opened`, `pr_merged`.

```json
[
  { "trigger": "branch_created", "enabled": false, "statusId": null },
  { "trigger": "pr_opened", "enabled": true, "statusId": "st_review…" },
  { "trigger": "pr_merged", "enabled": true, "statusId": "st_done…" }
]
```

#### A2 `PUT /projects/:id/dev-automation`

The body has the same shape: all three triggers, and an enabled trigger needs a `statusId` of this project.
Validation:

- `rules.<i>.statusId` "Choose a status." when it is missing or unknown;
- `pr_merged` must target a **done**-category status: "Pick a Done status." (otherwise a merged PR could reopen
  work).

Audit `project.dev_automation_updated` with `changes` per trigger. Publish `project.changed`
`areas: ["development"]`.

### 5.9 Error code catalogue (new)

| HTTP | Code | When |
|---|---|---|
| 503 | `integrations_unavailable` | kill switch, or the provider isn't configured |
| 409 | `integration_exists` | G3 token for an already-connected account |
| 409 | `integration_error` | G8, G11 while the integration is in error |
| 429 | `sync_throttled` | G11 within 2 min |
| 502 | `provider_failed` | the provider timed out or returned 5xx (`details.provider`, `details.status`) |
| 409 | `branch_exists` | D4 |
| 401 | `invalid_signature` | W1/W2 |
| 413 | `payload_too_large` | W1/W2 |
| 422 | `validation_failed` | field errors above |

---

## 6. Task-key matching

### 6.1 The regex (identical in Python and TypeScript; shared vectors §12.3)

```
(?<![A-Za-z0-9])([A-Za-z]{2,5})-([1-9][0-9]{0,6})(?![A-Za-z0-9])
```

- Matching is **case-insensitive**. Branch names are conventionally lowercase (`prj-42-fix-reflow`), and the design
  highlights `/prj-\d+/gi`. The prefix is upper-cased before lookup.
- Prefixes are 2–5 letters, because project keys match `^[A-Z]{2,5}$` (v1 constraint `project_key_format`). A
  number with a leading zero (`PRJ-042`) doesn't match.
- Boundaries are letters and digits only, so `feature/PRJ-42`, `(PRJ-42)`, `PRJ-42:`, `prj-42-fix`, `PRJ-42_x` and
  `[PRJ-42]` match, while `XPRJ-42`, `PRJ-42a` and `PRJ-4242424242` don't.
- **False positives** such as `UTF-8`, `SHA-256` and `ISO-8601` are dropped by step 6.2.2, because they aren't
  project keys of the workspace.

### 6.2 Resolution (`integrations.matching.resolve_keys(workspace, texts, project_scope)`)

1. Scan each text in order. Keep the distinct `(PREFIX, number)` pairs in first-seen order, **at most 10 per
   object** (§6.5).
2. **Prefix filter.** Keep only prefixes that appear in `ProjectKeyAlias` for this workspace, with
   `project__deleted_at IS NULL`. The alias table holds every key a project has used, current and retired. It is
   cached per workspace for 60 s and invalidated by project create, key change and delete.
3. **Task lookup by alias + number**, not by the stored key string:
   `Task.objects.filter(project=alias.project, number=n, deleted_at__isnull=True, project__deleted_at__isnull=True)`.
   This covers:
   - old tasks whose stored key keeps a retired prefix (`ABC-12` after a rename to `XYZ`);
   - new tasks referred to by an old prefix (`ABC-50` finds `XYZ-50`), consistent with v1 resolving old URLs.
   The lookup is one query for all the pairs.
4. **Workspace isolation.** Only the integration's workspace is searched, so a key that matches a project in
   another workspace is never linked. GitHub installations and repositories are unique per workspace (§3.1, §3.2).
5. **Repository scope** (§6.4). Tasks whose project the repository doesn't apply to are dropped silently.
6. Soft-deleted tasks and projects are skipped. **Archived** projects' tasks are linked (links are history, not
   edits), but automations skip them (§7.10).

### 6.3 Where keys are read

| Object | Texts scanned (in this order) |
|---|---|
| PR / MR | **title**, then the **head branch name**. The description/body is **not** scanned (§13 #3). |
| Branch | the branch name (on push/create events and in backfill) |
| Commit | the full commit **message** (subject and body) |

`feature/PRJ-42-x` and `PRJ-42/x` both match: the prefix before `/` is irrelevant.

**Branch name rules** (D4 validation, and the generator in §9.4): 1–80 characters; `^[A-Za-z0-9._/-]+$`; not
starting with `-`, `/` or `.`; not ending with `/`, `.` or `.lock`; no `..`, `//` or `@{`.

### 6.4 Repository → project scope

A repository applies to a project when `all_projects` is true (the default), or when the project is in
`Repository.projects`. This lets an admin keep `platform-team/infra-terraform` linked only to INF. A key for a
project outside the scope is ignored, as if it didn't exist. The design has no control for this; it is added in §9.3.

### 6.5 Caps

| Cap | Value | Beyond it |
|---|---|---|
| Keys per object (PR, commit, branch) | 10 | the rest are ignored |
| Commits per push processed | 100 (most recent) | GitHub webhooks carry up to 2,048 commits, and the rest are skipped. GitLab payloads carry 20 commits; when `total_commits_count > 20`, the processor fetches up to 100 more through `compare` (one API call). |
| Task links created per delivery | 200 | the rest are skipped and `delivery.error = "link_cap"` is recorded |
| Checks stored per PR | 20 | ordered failing first, then running, then by name |

### 6.6 Auto links follow their text; manual links don't

- When a PR's title or head branch changes (`edited`, `synchronize`), the processor recomputes its keys:
  - **new** keys add `auto` links;
  - keys that **disappeared** delete their `auto` links;
  - `manual` and `created` links are never removed by matching.
- `suppressed` rows are never revived by matching. Only D2 (re-link) clears the flag.
- Commits are immutable, so their links never change after creation.

---

## 7. Processing

### 7.1 Verify, store, answer fast

GitHub and GitLab both time out after **10 s** and treat any non-2xx as a failure. GitLab auto-disables hooks that
keep failing. The receiver therefore only verifies, inserts one row and returns: on the order of 10–30 ms, with no
outbound calls. Everything else happens in the processor.

### 7.2 Normalised events (`DevEvent`) and how they apply

| Provider event | Normalised | Effect |
|---|---|---|
| GH `pull_request` (opened, reopened, edited, synchronize, ready_for_review, converted_to_draft, closed) · GL `Merge Request Hook` (open, reopen, update, close, merge) | `pr_upsert` | Upsert the PR fields on every link row of this PR. Recompute keys (§6.6). `state` = `merged` if merged, `closed` if closed, `draft` if draft, else `open` (GL `locked` → `open`). Set `open_pr_count` ±1 on state transitions. Run automations on a transition into `open` (`pr_opened`) or `merged` (`pr_merged`). |
| GH `pull_request_review` (submitted, dismissed) · GL MR `approved`/`unapproved`/`approval`/`unapproval` | `review_update` | `approvals` = `approvals()` from the provider (one call; GitHub counts reviewers whose latest review is APPROVED) |
| GH `push` · GL `Push Hook` | `push` | Branch: `deleted`/`after == 0…0` → `branch_deleted`; otherwise `branch_upsert` (sha, updatedAt). Commits → `commit_upsert` for each commit with keys (§6.5 caps). After a branch push, `ahead_by` via `compare` (one call; skipped when the rate budget is low, §7.7). |
| GH `create` / `delete` (ref_type `branch`) | `branch_upsert` / `branch_deleted` | covers branches created without commits |
| GH `check_run` · GH `status` | `checks_update(sha)` | Upsert one check by name (check_run `name`; status `context`) on PR links whose `sha` = head sha. State map below. |
| GL `Pipeline Hook` | `checks_update(sha)` | Replace the checks of PR links with that sha by `builds[]` (name, status, duration). `allow_failure` failures count as passing. |
| GH `repository` (renamed, transferred, archived, unarchived, deleted) | `repo_update` | Update `full_path`/`archived`. `deleted` removes the `Repository`. |
| GH `installation_repositories` (removed) | `repo_removed` | Untrack. Links stay. |
| GH `installation` (suspend / unsuspend / deleted / new_permissions_accepted) | `integration_state` | Set or clear `error_code` (`installation_suspended`, `installation_removed`). `deleted` → error `installation_removed` (not auto-deleted; an admin sees it and disconnects or reconnects). |

**Check state map:**

| Provider value | Lightex state |
|---|---|
| GitHub `success`, `neutral`, `skipped`; GitLab `success`, `skipped`, `manual` (excluded from totals) | `passing` |
| GitHub `failure`, `timed_out`, `cancelled`, `action_required`, `startup_failure`, `stale`; status `error`/`failure`; GitLab `failed`, `canceled` | `failing` |
| GitHub `queued`, `in_progress`, `waiting`, `requested`, `pending`; GitLab `created`, `pending`, `running`, `preparing`, `waiting_for_resource`, `scheduled` | `running` |

Aggregate: any failing → `failing`; else any running → `running`; else `passing`; no checks → `null`. A new head
sha (`synchronize`, or a push to the PR branch) **clears** the checks.

**Ordering.** Deliveries can arrive out of order. A `pr_upsert` applies only when the payload's `updated_at` is
≥ the stored `source_updated_at`. Checks apply only to the current head `sha`. Commits are immutable.

### 7.3 Dispatch, leases and recovery (board 40's pattern, no Redis)

- `integrations.runner.dispatch()` runs in `transaction.on_commit` after a webhook insert, a sync request, a
  disconnect or D4:
  - `INTEGRATIONS_RUNNER=celery` (broker configured): `apps.integrations.tasks.drain.delay()`;
  - **`thread`** (Render free plan, compose without the worker profile): wakes **one** daemon drain thread per web
    process (started lazily, guarded by a lock). It never spawns a thread per webhook, so a burst of 100 deliveries
    doesn't create 100 threads. The thread closes its DB connection when idle;
  - `inline` (tests): drains synchronously.
- **Drain loop.** Repeats until there is no work:
  1. Claim up to 20 deliveries: `SELECT … FROM webhookdelivery WHERE status='received' OR (status='processing' AND
     locked_at < now() - interval '120 s') ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 20`, then set
     `status='processing'`, `lease_token`, `locked_at`, `attempts += 1`.
  2. Process each in **its own transaction**: normalise, apply, and mark `processed` / `ignored`. On an exception:
     back to `received` if `attempts < 5`, else `failed` with `error`.
  3. Claim one due sync run: `status IN ('queued','deferred') AND run_after <= now()`, with the same lease and
     heartbeat as board 40 (`heartbeat_at` stale after 120 s → reclaimable).
- **Recovery without cron.** Render's free plan has no cron jobs. Stuck or failed-to-start work is picked up by:
  - the next webhook's dispatch, because each drain also reclaims stale leases;
  - G1/D1 opening (catch-up, §7.6);
  - `manage.py process_integrations`. Run it every 5 min where cron exists (compose `worker` profile, a paid Render
    cron). It also runs `purge_integrations`.
- Celery tasks: `acks_late=True`, `autoretry_for=(OperationalError, InterfaceError)`, `max_retries=3`.

**Author matching.** A Lightex member is matched only when the commit's author email (or the PR author's public
email, when the payload carries one) equals the email of an **active member of the workspace**, compared lower-case.
GitHub `noreply` addresses never match. A match sets `author_user`, and the UI then uses the member's name and hue.

### 7.4 Backfill on connect (`kind=backfill`, one run per added repository)

| Item | Limit |
|---|---|
| PRs/MRs | all **open** ones, plus those updated in the last `INTEGRATION_BACKFILL_DAYS` (30); at most `INTEGRATION_BACKFILL_MAX_PRS` (200), newest first |
| PR commits | the first 50 commits of each PR that has keys |
| Branches | list up to 1,000 (10 pages); keep only names with keys |
| Commits | default branch, last 30 days, at most 300 |
| Checks / approvals | only for open PRs that have links (≤ 50 PRs) |
| `ahead_by` | only for linked active branches (≤ 50) |
| API request budget | 120 per repository; on reaching it, stop and set `stats.partial = true` (the settings row shows "partial sync" in its tooltip) |

A backfill creates links with **no automations, no notifications and no per-link audit rows**: it is history, not
news. At the end it writes one audit row, `integration.backfilled`
`data: { repository, prs, branches, commits, links, partial }`, then sets `backfilled_at`/`last_synced_at` and
publishes `integration.changed` op `synced`. A task's panel fills in on its next fetch, because the run publishes
`tasks.bulk_changed` per project with `taskIds` (≤ 200) or `null`.

`sync` and `catchup` runs are **incremental**: PRs/MRs `updated_since = last_synced_at − 5 min`, branches (scan,
1,000 cap) and commits `since` the same time. **Automations do run** for state transitions found by an incremental
sync, because a merge missed while webhooks were down should still move the task.

### 7.5 Credentials at runtime

- **GitHub:** installation tokens are cached encrypted in `credentials` until 5 min before `expiresAt`. Every
  process can reuse them, and they are re-minted on demand.
- **GitLab OAuth:** refreshed when it has less than 5 min left, under `select_for_update` on the integration. The
  refresh token rotates, so two processes must never use the old one twice. A refresh fails with `invalid_grant`
  → `error_code = token_expired`, the repositories pause, and Reconnect is offered.
- **GitLab token:** a 401 on any call → `token_revoked`. A daily check
  (`process_integrations --check-tokens`, and on catch-up) compares `token_expires_at` with now: expired →
  `token_expired`; less than 7 days left → the card meta reads "token expires in 5d".

### 7.6 Catch-up after downtime (free-plan spin-down)

Render's free web service sleeps after 15 min without traffic. GitHub and GitLab **don't retry** failed deliveries,
and a cold start can exceed their 10 s timeout. A `catchup` run is enqueued when:

- an integration's `last_synced_at` is older than `INTEGRATION_CATCHUP_MINUTES` (30) and G1 or D1 is called;
- or by `process_integrations`.

The run does three things:

1. **GitHub:** list `GET /app/hook/deliveries?per_page=100` (app JWT) back to the last processed delivery time, at
   most 3 days and 300 deliveries. For failed deliveries of **this installation** that we haven't stored
   (`delivery_id` unknown), call `POST /app/hook/deliveries/{id}/attempts`. GitHub then resends them, and
   idempotency makes duplicates harmless.
2. **GitLab:** for each repository, `GET /projects/:id/hooks/:hook_id`. If the hook is disabled
   (`disabled_until`/`alert_status` not `executable`), re-enable it with `PUT`.
3. Then run an incremental sync (§7.4) for every tracked repository.

The recommended production setup is a paid instance or a cron running `process_integrations`; without either, the
catch-up path still keeps the data correct (§13 #9).

### 7.7 Rate limits

- Outbound: every response's `X-RateLimit-Remaining`/`X-RateLimit-Reset` (GitHub) and `RateLimit-Remaining`/
  `RateLimit-Reset` (GitLab) are kept per integration, in process memory and on the run's `stats`.
- **Low budget** (remaining < 200 on GitHub, < 50 on GitLab): optional enrichment (`ahead_by`, approvals refetch)
  is skipped, and sync runs move to `deferred` with `run_after = reset`.
- A `403`/`429` with `Retry-After`, or GitHub's secondary rate limit message, defers the run with that delay. The
  webhook processor never sleeps; enrichment that can't run is skipped and filled in by the next sync.
- Inbound: the throttle scopes in §2.3; G11's 2-minute rule.

### 7.8 The fake provider (dev, tests and parity with the mock)

`INTEGRATIONS_PROVIDER_BACKEND=fake` swaps both providers for `FakeProvider`.

**Fixtures** are the design's eight repositories:

- `platform-team/{web, api, board-engine, mobile-app, infra-terraform, design-tokens}`;
- `alexkim/{reflow-bench, dotfiles}`;
- with the design's visibilities, update ages and open PR counts. PRs, branches and commits come from §9.8.

**Connect:**

- `authorize_url` → `<API_PUBLIC_URL>/api/v1/integrations/fake/authorize?state=…&provider=github`. That route only
  exists while the fake backend is active, and 404s otherwise. It redirects straight to the provider's normal
  callback with `code=fake-ok`, or `error=access_denied` when `&deny=1`.
- Token mode accepts `fake-token`, and `fake-noscope` (gives `insufficient_scope`).

**Webhooks:** `manage.py fake_webhook --provider github|gitlab --event pr_opened|pr_merged|checks_failed|push
--key PRJ-42 [--workspace platform]` builds a provider-shaped payload, **signs it with the real verification
scheme**, and posts it through the Django test client. The full path is exercised.

### 7.9 Disconnect and revocation

After the commit of G13, the runner:

1. **GitHub:** `DELETE /app/installations/{id}` (app JWT). This uninstalls the app from the org, which is the only
   complete revocation of an installation's access. A 404 counts as done.
2. **GitLab:**
   - delete every project hook;
   - OAuth → `POST /oauth/revoke` for the access and refresh tokens;
   - token mode → `DELETE /personal_access_tokens/self` **only when** `GET /user` reported `bot: true`, i.e. a
     group or project access token made for Lightex. A personal access token is wiped locally, not revoked
     (§13 #5).
3. Wipe `credentials`/`webhook_secret` (overwrite with `""`), then delete the integration (cascading to its
   repositories, attempts and runs).
4. Update the audit row's `data.revoked` to `true`/`false`. A revocation failure **does not block** the local
   delete, and a `false` is shown in the audit log.

### 7.10 Automations (system actor)

`integrations.automation.apply(trigger, link_rows)` runs inside the delivery's transaction, after the PR or branch
update, once per linked task:

1. Skip if the task's project is archived or deleted, if the task's project has no enabled rule for the trigger, or
   if the link is `suppressed`.
2. **Forward-only guard:**
   - `branch_created` / `pr_opened` apply only when the task's status category is `todo`;
   - `pr_merged` applies only when the category isn't `done` **and** no other visible PR of the task is still
     `open`/`draft`. "Move to Done when the last open PR merges", so splitting work across PRs doesn't close the
     task early.
3. Skip if the task is already in the target status.
4. Call `tasks.services.update_task(actor=None, task, {"statusId": rule.status_id, "version": task.version},
   system=IntegrationActor(integration))`. **This is the normal service path**:
   - `version` bump;
   - `TaskStatusHistory` (`changed_by=NULL`);
   - `completed_at`/`started_at`;
   - position at the end of the target column;
   - search vector;
   - the `status_change` domain event;
   - the audit row (§8.1);
   - realtime `task.changed` (board 33 audit hook).
   `IntegrationActor` carries `name="GitHub"`/`"GitLab"` and `ref=integration.id`. The audit writer stores
   `actor_kind="integration"`, `actor_ref`, `actor_name` and `source="webhook"`.
5. The permission check is skipped (the actor is the system), but the rule itself was set by a holder of
   `status.manage`.

D4's `branch_created` automation runs the same function with the integration as the actor. The person who clicked
already shows in the `task.dev_branch_created` row.

---

## 8. Side effects

### 8.1 Audit rows (`apps.audit.services.record`, extended with `actor_kind`/`actor_ref`)

| Action | Scope | Actor | `target` | `data` / `changes` | `source` |
|---|---|---|---|---|---|
| `integration.connected` / `.reconnected` | ws | user | "GitHub · platform-team" | `{ provider, account, authKind }` | `web` |
| `integration.repositories_updated` | ws | user | same | `{ added: ["platform-team/web"], removed: [] }` | `web` |
| `integration.repository_scoped` | ws | user | repo path | `{ projects: ["INF"] \| "all" }` | `web` |
| `integration.sync_requested` | ws | user | same | `{}` | `web` |
| `integration.backfilled` | ws | integration | repo path | `{ prs, branches, commits, links, partial }` | `webhook` |
| `integration.error` / `.recovered` | ws | integration | same | `{ code }` | `webhook` |
| `integration.disconnected` | ws | user | same | `{ provider, account, repositories: 4, revoked: true }` | `web` |
| `task.dev_linked` | ws, project, task | user (manual) or integration (auto) | task title | `{ provider, kind: "pull_request" \| "branch", ref: "#214", repo, url, title }` (**PR/MR and branch only**; commits are not audited, §8.2) | `web` / `webhook` |
| `task.dev_unlinked` | ws, project, task | user | task title | `{ provider, kind, ref, repo }` | `web` |
| `task.dev_branch_created` | ws, project, task | user | task title | `{ provider, repo, branch }` | `web` |
| `task.dev_pr_state` | ws, project, task | integration | task title | `changes: [change("PR #214", "open", "merged", "text")]`, `data: { ref, repo, url }` (merged/closed/reopened only) | `webhook` |
| `task.status_changed` (automation) | ws, project, task | integration | task title | v1 `changes` + `data: { rule: "pr_merged", ref: "#214" }` | `webhook` |
| `project.dev_automation_updated` | ws, project | user | project name | per-trigger `changes` | `web` |

`AuditEntry` for integration rows:

- `actorId` = the integration id (`actor_ref`);
- `actorKind: "integration"`;
- `actorName: "GitHub"`.

The board 31 audit screen already renders these: its actor filter lists integrations seen in the log, with the
square mono avatar. `filter[actor]=<integrationId>` matches `actor_ref`. Secrets never reach `data`: the existing
`_scrub` also covers the keys `token`, `secret`, `credentials` and `code`.

### 8.2 Activity feed (`audit.selectors.ACTIVITY_VERBS` + frontend `ActivityVerb`)

| Action | Verb | Text (`activity-text.ts`) |
|---|---|---|
| `task.dev_linked` (PR/MR) | `dev_linked` | "linked PR #214" / "linked MR !12". The actor is `actorName` for integrations: "GitHub linked PR #214". |
| `task.dev_branch_created` | `dev_branch_created` | "created branch prj-42-fix-reflow" |
| `task.dev_pr_state` with to = `merged` | `dev_pr_merged` | "GitHub · PR #198 merged" |

`task.dev_linked` for **branches**, `task.dev_unlinked`, other PR state changes and all `integration.*` rows are
**audit-only**. Commits have no audit row at all: a busy repository would bury the feed, and the Development section
already lists them. The automation's `task.status_changed` row appears normally: "GitHub moved this to Done".

`activity_data()` adds `actorName` (from `actor_name`) and `actorKind`. `actorId` stays `null` for integration rows
in the activity payload. The client renders the square integration avatar when `actorKind === "integration"`.

### 8.3 Notifications

- **No new notification type.** The automation's `status_change` event uses the v1 handler (recipients: assignee
  and reporter, project members, never the actor), with `actor_id = NULL` and `payload.via = "github" | "gitlab"`.
  Inbox text: "GitHub moved **PRJ-42** to Done" (`via` replaces the actor name; a system avatar). The `status_change`
  preference applies.
- Linking, merging and checks don't notify (noise; §13 #8).
- Integration errors don't notify: v1 notifications need a project, and integrations are workspace-level. The error
  shows on the settings page, and as a dot on the Settings nav item for holders of `integration.manage` (§9.3).

### 8.4 Realtime (board 33 stream)

| Event | Kind | Delivered to | `data` | Emitted by |
|---|---|---|---|---|
| `task.changed` | durable | project members | v1 shape with `op: "updated"`, `version: null` (no bump), `fields: ["development"]` | link insert/update/delete per task (one per task per processed delivery); D2–D4 |
| `task.changed` | durable | project members | normal (`version` = new version, `fields: ["statusId"]`) | automation, via the audit hook |
| `tasks.bulk_changed` | durable | project members | `{ taskIds, op: "updated" }` | backfill/sync runs, once per project |
| `integration.changed` | durable | **every member of the workspace** (`projectId: null`, the hub delivers it to every connection of the workspace) | `{ integrationId, op: "connected" \| "updated" \| "synced" \| "error" \| "disconnected" }` | G6, G9, G10, sync completion, error transitions, G13 |
| `project.changed` | durable | project members | `{ areas: ["development"] }` | A2; G9/G10 when they change which projects a repository applies to |

Data minimisation is unchanged: ids and field names only; titles and PR data are refetched through D1. Add
`"development"` to `project.changed` `areas`, and add `integration.changed` to the board 33 catalogue (clients
already ignore unknown types). **Without board 33 deployed** everything still works through v1 refetch-on-focus and
the polling rules in §9.6.

---

## 9. Frontend

Lift the ban first, and keep the paper trail:

- `frontend/CLAUDE.md` "v2 features, only as scoped": move **board 37** to "In scope", built from
  `docs/v2/37-integrations-github-gitlab.md`.
- `docs/final-report.md`:
  - add a §8 entry;
  - add every endpoint and field of §5 under "Requested API additions";
  - list the conflicts of §11.
- **No new npm dependency.**

### 9.1 `src/lib/api/types.ts`

The §5.1 shapes (`Provider`, `ProviderInfo`, `Integration`, `IntegrationErrorCode`, `Repository`,
`AvailableRepository`, `IntegrationsOverview`), plus:

```ts
interface RepoRef { id: ID; fullPath: string }
interface DevAuthor { login: string; name: string | null; userId: ID | null }
type CheckState = "passing" | "failing" | "running";
interface DevCheck { name: string; state: CheckState; durationSec: number | null; url: string | null }

interface DevPullRequest {
  id: ID; kind: "pull_request"; provider: Provider; repository: RepoRef | null; repoFullPath: string;
  number: number; ref: string; title: string; url: string;
  state: "open" | "draft" | "merged" | "closed";
  headBranch: string; baseBranch: string; author: DevAuthor;
  checks: { state: CheckState; passed: number; total: number; items: DevCheck[] } | null;
  approvals: number; linkSource: "auto" | "manual" | "created";
  createdAt: ISODateTime; updatedAt: ISODateTime; mergedAt: ISODateTime | null; closedAt: ISODateTime | null;
}
interface DevBranch {
  id: ID; kind: "branch"; provider: Provider; repository: RepoRef | null; repoFullPath: string;
  name: string; url: string; state: "active" | "deleted"; aheadBy: number | null;
  linkSource: "auto" | "manual" | "created"; updatedAt: ISODateTime;
}
interface DevCommit {
  id: ID; kind: "commit"; provider: Provider; repository: RepoRef | null; repoFullPath: string;
  sha: string; shortSha: string; message: string; url: string; author: DevAuthor;
  committedAt: ISODateTime; linkSource: "auto" | "manual";
}
type DevItem = DevPullRequest | DevBranch | DevCommit;

interface TaskDevelopment {
  taskId: ID; taskKey: string; enabled: boolean; suggestedBranch: string;
  repositories: { id: ID; provider: Provider; fullPath: string; name: string; defaultBranch: string; canCreateBranch: boolean }[];
  pullRequests: DevPullRequest[]; branches: DevBranch[]; commits: DevCommit[]; commitTotal: number;
  syncedAt: ISODateTime | null;
}

interface TaskDevSummary {
  pr: { provider: Provider; number: number; ref: string; state: DevPullRequest["state"]; checks: CheckState | null;
        checksPassed: number; checksTotal: number; approvals: number; baseBranch: string; mergedAt: ISODateTime | null } | null;
  prCount: number; branchCount: number; commitCount: number;
}

type DevTrigger = "branch_created" | "pr_opened" | "pr_merged";
interface DevAutomationRule { trigger: DevTrigger; enabled: boolean; statusId: ID | null }
```

Additive fields:

- `Task.dev: TaskDevSummary | null`;
- `Project.devEnabled: boolean`;
- `ActivityEntry.actorName?: string | null` and `actorKind?: "user" | "integration"`;
- `ActivityVerb` gains `"dev_linked" | "dev_branch_created" | "dev_pr_merged"`;
- `AuditEntry.source` gains `"webhook"`;
- `Notification.payload.via?: Provider`;
- `WORKSPACE_PERMISSIONS`/`PROJECT_PERMISSIONS` per §4.3.

The `Task` and `Project` fields are declared **required**; deploy the backend first, as for board 39.

### 9.2 `src/lib/api/endpoints.ts` and `query-keys.ts`

```ts
integrations: {
  overview: (slug: string) => get<IntegrationsOverview>(`/workspaces/${slug}/integrations`),
  connectGitHub: (slug: string) => post<{ authorizeUrl: string }>(`/workspaces/${slug}/integrations/github/connect`, {}),
  connectGitLab: (slug: string, body: { method: "oauth" } | { method: "token"; baseUrl: string; token: string }) =>
    post<{ authorizeUrl: string } | Integration>(`/workspaces/${slug}/integrations/gitlab/connect`, body),
  confirm: (slug: string, body: { attempt: string; token: string }) => post<Integration>(`/workspaces/${slug}/integrations/confirm`, body),
  get: (id: ID) => get<Integration>(`/integrations/${id}`),
  availableRepositories: (id: ID, q?: string) => get<AvailableRepository[]>(`/integrations/${id}/available-repositories`, { q }),
  setRepositories: (id: ID, repositories: { externalId: string; projectIds?: ID[] }[]) =>
    put<Integration>(`/integrations/${id}/repositories`, { repositories }),
  scopeRepository: (repoId: ID, projectIds: ID[]) => patch<Repository>(`/repositories/${repoId}`, { projectIds }),
  sync: (id: ID) => post<Integration>(`/integrations/${id}/sync`, {}),
  reconnect: (id: ID, body: { token?: string } = {}) => post<{ authorizeUrl: string } | Integration>(`/integrations/${id}/reconnect`, body),
  disconnect: (id: ID) => del(`/integrations/${id}`),
},
development: {
  get: (taskId: ID) => get<TaskDevelopment>(`/tasks/${taskId}/development`),
  link: (taskId: ID, url: string) => post<DevItem>(`/tasks/${taskId}/development/links`, { url }),
  unlink: (taskId: ID, linkId: ID) => del(`/tasks/${taskId}/development/links/${linkId}`),
  createBranch: (taskId: ID, body: { repositoryId: ID; name: string }) => post<DevBranch>(`/tasks/${taskId}/development/branches`, body),
  rules: (projectId: ID) => get<DevAutomationRule[]>(`/projects/${projectId}/dev-automation`),
  setRules: (projectId: ID, rules: DevAutomationRule[]) => put<DevAutomationRule[]>(`/projects/${projectId}/dev-automation`, rules),
},
```

`qk` additions:

- `integrations: (slug) => ["workspace", slug, "integrations"]`;
- `availableRepos: (integrationId, q) => ["integration", integrationId, "available", q ?? ""]`;
- `development: (taskId) => ["t", taskId, "development"]`;
- `devRules: (projectId) => ["p", projectId, "dev-rules"]`.

### 9.3 Settings route and components (`src/features/integrations/`)

- **Route:** `src/app/[workspace]/settings/integrations/page.tsx` renders `IntegrationsScreen`. `SettingsSection`
  gains `"integrations"`. The nav item "Integrations" (lucide `Plug`) goes after "Roles", for **every** member. It
  shows a warning dot when the overview has an error integration and the viewer holds `integration.manage`.

| Component | Notes |
|---|---|
| `integrations-screen.tsx` | `useQuery(qk.integrations)`. Loading = the design's skeleton; error = `ErrorState` + Retry. Sections: **Source control**, **Task keys**. Reads the `#connect=` / `#connect_error=` fragment on mount (§9.6). |
| `provider-tile.tsx` | One per provider **not yet connected**. Shows the Connect button, the "Waiting for authorization…" busy state + Cancel while the redirect is pending, or the lock note (no `integration.manage`): "Can't connect · needs Manage integrations" (§11 #5). Unavailable provider → disabled button with `disabledReason` "GitHub isn't set up on this server." |
| `connection-card.tsx` | One per integration (design "Connected + status"): badge (Connected / error label from §9.7), meta, Sync now, Edit repos, Reconnect, Disconnect; repository rows. A per-row "All projects ▾" `Menu` (managers) for the project scope (G10). For the second org of the same provider, a quiet "Add organization" (GitHub) / "Add GitLab connection" link in the card footer. |
| `gitlab-connect-dialog.tsx` | `Modal` opened by "Connect GitLab": two `FilterPills`, "GitLab.com" (OAuth; hidden when `methods` lacks `oauth`) and "Access token" (instance URL + token, with help text naming the scope and role from §2.2). Field errors come from the 422. |
| `repo-picker.tsx` | The design's "Choose repositories" modal: search (60 chars), grouping by `owner` with tri-state select-all and `n/m`, visibility, relative `updatedAt`, skeleton, no-match + Clear search, footer count, "Connect N repos" / "Save · N repos" (disabled at 0 with `disabledReason` "Choose at least one repository"). `trackedElsewhere` rows are disabled with the reason "Connected through another account". Footer link "Missing a repository? Change access on GitHub" (`manageUrl`). Cancel on the **first** picker after a connect calls `disconnect` (the design returns to "not connected"). |
| `disconnect-dialog.tsx` | The design's alertdialog, with copy unchanged. Cancel is autofocused. Optimistic removal with rollback; toast "GitHub disconnected". |
| `task-keys-card.tsx` | The three examples (static copy from the design) and the branch-name generator. The task select is the caller's open tasks in this workspace (`qk.myTasks`, first 20), and is hidden when they have none. Prefix pills `plain` / `feature/`; Copy → "Copied" for 1.4 s. |
| `lib/key-match.ts` | `KEY_RE`, `findKeys(text, prefixes)`, `highlightKeys(text, prefixes)` → parts for `<mark>`. Prefixes = the workspace's current project keys from `useProjects`. |
| `lib/branch-name.ts` | `suggestBranch(key, title, prefix = "")` and `validateBranch(name)` (§6.3), shared vectors. |

### 9.4 Branch name suggestion (design `slug()`, made deterministic)

```
suggestBranch(key, title, prefix=""):
  words = NFKD(title).stripCombiningMarks().toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .split(/\s+/).filter(w => w && !STOP.has(w)).slice(0, 4)
  name  = [key.toLowerCase(), ...words].join("-").replace(/-{2,}/g, "-").replace(/-+$/, "")
  return (prefix + name).slice(0, 80).replace(/[-/.]+$/, "")
STOP = on the a an to for of in and with
```

The server computes the same `suggestedBranch` (Python port; same vectors, §12.3).

### 9.5 Task panel, board and project settings

- **`features/development/development-section.tsx`** sits in the task panel's main column above Description, as in
  the design (side panel, full page and mobile sheet).
  - **When it renders:** `project.devEnabled || task.dev !== null`.
  - **Data:** `useQuery(qk.development(task.id))`. Loading = the design skeleton; empty = "No linked work yet", the
    suggested branch, Copy, and "Use PRJ-58 in a branch, PR or commit"; error = an inline `ErrorState` with Retry
    inside the section.
  - **Header count:** "4 PRs · 2 branches" (GitLab "MRs"; mixed providers → "PRs"); the "Branch created" flash.
  - **Create branch** (only with `development.link`, `enabled`, and at least one repository with
    `canCreateBranch`): the design's popover. The name is prefilled with `suggestedBranch` and validated on the
    client with `validateBranch`, so the server's 422 is rare. "from {defaultBranch} in [repo ▾]". Create ↵ is not
    optimistic: the button shows a spinner (it is a remote write). On success: append the branch to the cache,
    flash "Branch created", invalidate `qk.task`/board. On 409, show the inline field error.
  - **⋯ menu** next to Create branch (`development.link`): "Link pull request or commit…" opens a small `Modal` with
    a URL input, which calls D2 (§11 #10).
  - **Rows:**
    - PR rows: state pill, `ref`, title with highlighted keys, checks button (`aria-expanded`, the design's
      `aria-label` "Checks Failing, 1 of 3 passing"), avatar. Expanded check rows: icon, name, state label, duration
      `2m 14s`.
    - Branch rows: name, repo name, meta = `aheadBy != null ? "3 ahead" : relative(updatedAt)`, Copy.
    - Commit rows: `shortSha` (mono), message (first line, keys highlighted), avatar, relative time.
    - Every row opens `url` in a new tab (`rel="noopener noreferrer"`).
    - Each row has an "Unlink" item in a row `Menu` (`development.link`): optimistic removal from the
      `qk.development` cache with rollback and toast "Unlinked #214 · Undo". Undo calls D2 with the row's `url`.
  - **Freshness:**
    - realtime `task.changed` with `"development"` in `fields` → invalidate `qk.development(taskId)`;
    - without the stream: refetch on focus, plus `refetchInterval` 30 s while the panel is visible **and** any PR has
      `checks.state === "running"`.
- **Board card** (`features/board/task-card.tsx`): when `task.dev?.pr` is set, add the design's chip (icon by state,
  `ref`).
  - **Variants:** failing = open with `checks === "failing"` (danger tone, ✕); open; draft (muted, uses the open
    icon); merged (info tone).
  - **Tooltip:**
    - "#214 · 2 of 3 checks failing" (`checksTotal - checksPassed` of `checksTotal`);
    - "#221 · checks passing · 1 review";
    - "#187 · merged into main · Oct 6".
  - `aria-label` follows the design: "Pull request #214, open, checks failing".
  - **Placement:** the chip sits with the existing card meta and wraps at 390 px. List rows get the same chip in
    the key column.
- **Project settings → "Development" tab** (`?tab=development`, shown when `project.devEnabled`; §11 #11):
  - a read-only list of the repositories that apply to this project, linking to workspace settings for managers;
  - three rule rows, "When a branch is created / a pull request is opened / a pull request is merged → move to
    [status ▾]", each with an on/off switch. Editable with `status.manage`; otherwise `ReadOnlyNote`.
  - `pr_merged`'s select lists done-category statuses only. Save goes through the v1 `SaveBar`.
- **Activity and inbox:** `activity-text.ts` handles the three new verbs, plus `actorKind: "integration"` (use
  `actorName` and the square avatar from `audit-parts.tsx`). The inbox renders `payload.via` as the actor:
  "GitHub moved PRJ-42 to Done".

### 9.6 The redirect flow on the client (no CSP change)

1. **Connect.** Call G2/G3 (or G12), then show the tile's busy state ("Waiting for authorization…"). Store
   `{ provider, startedAt }` in `sessionStorage["lightex-int-connect"]` so a return without a fragment can say
   "Connection cancelled". Then `window.location.assign(authorizeUrl)`. A top-level navigation is not governed by
   CSP (`form-action`/`connect-src` don't apply), so **`next.config.ts` needs no change**.
2. **Return.** On mount, `IntegrationsScreen` parses `location.hash`:
   - `#connect=<attempt>.<token>`: immediately `replaceUrl` without the hash, so the token leaves the address bar
     and history; then call G6. On success:
     - for a connect, open the repo picker for the returned integration;
     - for a reconnect, show the toast "GitHub reconnected".
     On 404, show the banner "That connection link expired. Try again."
   - `#connect_error=<code>`: clear the hash and show the §5.3 copy in an inline `Alert` above Source control.
3. **Token mode** (GitLab) is a plain JSON call; no redirect.
4. **Mock mode:** `authorizeUrl` is
   `/<ws>/settings/integrations#mock-authorize=<provider>.<attemptId>`. Assigning a same-document fragment doesn't
   reload, so the screen listens to `hashchange` and renders **the design's "Authorize Lightex" dialog** as the fake
   provider's consent page. The permission chips are the real ones from §2.1/§2.2. Authorize → the mock's
   `confirm`, then the picker. Cancel → `#connect_error=github_cancelled`.
5. Avatars are **initials + hue** only. No provider avatar URLs are loaded, so `img-src` doesn't change either.

### 9.7 Copy

| Code | Badge | Meta |
|---|---|---|
| (active) | Connected | "4 repos · last sync 2m" (`syncing` → "last sync …") |
| `token_expired` | Token expired | "expired 3d ago · 4 repos paused" |
| `token_revoked` | Access revoked | "revoked 3d ago · 4 repos paused" |
| `installation_suspended` | Suspended on GitHub | "since Oct 6 · 4 repos paused" |
| `installation_removed` | Uninstalled on GitHub | "since Oct 6 · 4 repos paused" |
| `insufficient_scope` | Missing permissions | "Reconnect to grant access" |
| `unreachable` | Can't reach GitLab | "since 2h · retrying" |
| `webhook_failing` | Webhooks failing | "last delivery 2h ago" |

Without `integration.manage`, the error card shows "Ask a workspace admin to reconnect" in place of the design's
"Admin reconnects".

The hue for an unmatched author is `hashHue(login) = (sum of char codes × 37) mod 360`, with shared vectors.

### 9.8 Mock backend (`src/lib/mock/handlers/integrations.ts`, `registerIntegrations()`)

- **New optional DB collections** (no `SCHEMA` bump): `integrations`, `repositories`, `devLinks`, `devRules`,
  `connectAttempts`. The handlers implement G1–G13 and D1–D4/A1–A2 with the same validation copy, status codes and
  permission checks (`integration.manage` from the workspace role, `development.link`/`status.manage` from the
  project role). `Task.dev` and `Project.devEnabled` are derived in `derive.ts`.
- **Fake provider:** the design's `REPOS` (8 repositories in two orgs, with `upd`, `vis` and open PR counts).
  Available-repository loading waits 700 ms (the design's skeleton timing), within the mock latency controls.
- **Seed** (`platform` workspace):
  - GitHub integration `int_gh_platform`, account `platform-team`, connected by `u_alex`, tracking `web`, `api`,
    `board-engine` and `mobile-app` (all projects), last sync 2 min ago;
  - no GitLab integration, so the GitLab tile shows "Connect";
  - PRJ links taken from the design:
    - **PRJ-42**: PRs #214 (open, failing: `e2e / board-drag` failing 2m 14s, `unit / reflow` failing 48s, `lint`
      passing 12s; author AK), #209 (draft, running; SP), #198 (merged; JL), #190 (closed, no checks; AK); branches
      `prj-42-fix-reflow` (web, 3 ahead) and `prj-42-reflow-tests` (web, 1 ahead); commits a3f9c21, 7be04d8,
      e51c7aa and 0c2d9f3 with the design's messages and authors;
    - **PRJ-41**: #221 (open, passing, 1 approval);
    - **PRJ-29**: #187 (merged into main, Oct 6);
    - **PRJ-58**: no links (the empty state).
  - PRJ automation: `pr_merged → Done` enabled, the rest off.
  - `seed_demo` loads the same data through `FakeProvider` fixtures.
- **Dev pill → "Integrations" controls** (mock only): "Open PR on…", "Merge PR", "Fail checks" and "Expire GitHub
  token" for the focused task. They mutate the DB exactly as the backend processor would, including the automation,
  audit row, notification and realtime event. This makes the board chip, panel and inbox demonstrable without a
  provider.

---

## 10. Security

### 10.1 Webhook verification (constant time)

- **GitHub:**
  1. `expected = "sha256=" + hmac.new(GITHUB_WEBHOOK_SECRET, raw_body, sha256).hexdigest()`;
  2. `hmac.compare_digest(expected.encode(), header.encode())`;
  3. a missing header, another prefix (`sha1=`), or a length mismatch → 401.
  The raw bytes are verified **before** JSON parsing. The secret can rotate: `GITHUB_WEBHOOK_SECRET` accepts a
  comma-separated list, and verification passes if any entry matches (each compared in constant time). That allows
  a zero-downtime rotation.
- **GitLab:** `hmac.compare_digest(decrypt(integration.webhook_secret).encode(), header.encode())`. The secret is
  per integration, 32 random bytes, and set by Lightex when it creates the hook. Rotate it with
  `rotate_integration_secrets --webhooks`, which updates every hook through `PUT /projects/:id/hooks/:hook_id`.
- Verification failures are logged with the delivery id and source IP only, never the body. The 401 has no detail.
- Replay: a resent valid delivery is a duplicate by `delivery_id` (200, no effect). GitLab without an event UUID
  falls back to `sha256(body)`.

### 10.2 Encryption at rest

- **Algorithm:** AES-256-GCM (`cryptography.hazmat.primitives.ciphers.aead.AESGCM`) with a 96-bit random nonce per
  encryption.
- **Format:** `lx1.<kid>.<b64url(nonce)>.<b64url(ciphertext‖tag)>`.
- **Associated data:** `"<app_label>.<model>:<row id>:<field>"`. A ciphertext copied into another row or column
  fails to decrypt.
- **Keys:** `INTEGRATIONS_ENCRYPTION_KEYS="k2:<32B b64url>,k1:<…>"`. The first key encrypts; any key decrypts by
  `kid`. `manage.py rotate_integration_secrets` re-encrypts every field with the first key, and the old key can then
  be removed.
- **Dev/test:** with no key set, `kid=dev`, derived with HKDF-SHA256 from `DJANGO_SECRET_KEY` (info
  `"lightex-integrations"`). `config/settings/prod.py` raises `ImproperlyConfigured` when a provider is configured
  without `INTEGRATIONS_ENCRYPTION_KEYS`.
- **Encrypted fields:** `Integration.credentials`, `Integration.webhook_secret`, `ConnectAttempt.pkce_verifier`.
  The GitHub private key and webhook secret stay in the environment, never in the DB. Decrypted values exist only
  inside `providers/` calls, are never logged, never serialised (no serializer field reads these columns), and are
  scrubbed from audit `data`. The Django admin doesn't register these models in production (v1: admin off).
- **Dependency:** `cryptography==46.0.3`, added to `requirements.txt`. **Why:**
  - the standard library has no authenticated cipher, and hand-rolled crypto is not an option;
  - the GitHub App needs RS256 JWTs anyway, and PyJWT (already installed through `djangorestframework_simplejwt`)
    needs `cryptography` for RS algorithms;
  - it ships manylinux wheels for Python 3.12, so the Docker image needs no build tools.
  One dependency covers both needs, and §4 of the final report records it.

### 10.3 OAuth and state

- `state` is 256 bits of randomness, stored hashed, single-use, and valid for 10 minutes. It is bound to the user and
  workspace **and** completed by the authenticated confirm call with a second secret carried in a URL fragment
  (§5.3). This defends against login-CSRF and installation-swap attacks without third-party cookies.
- GitHub installation ownership is verified against the installer's own `GET /user/installations`.
- GitLab OAuth uses PKCE S256.
- Callback redirects only ever go to `FRONTEND_URL` plus the workspace slug, which comes from the attempt record,
  never from a query parameter. There is no open redirect.
- The callback and setup views carry `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

### 10.4 SSRF protection for self-managed GitLab

`http.SafeTarget(base_url)` is applied on **every** outbound GitLab call, not only at connect time:

1. Parse with `urllib.parse`. The scheme must be `https`; `http` is allowed only with
   `GITLAB_ALLOW_PRIVATE_NETWORKS=true` in dev. No userinfo, no path, query or fragment (they are stripped). Ports
   are 443 or 1024–65535. The host is IDNA-encoded and lower-cased.
2. The host must match `GITLAB_ALLOWED_HOSTS` when that is set.
3. **Resolve** with `socket.getaddrinfo`. **Every** resulting address must be `ipaddress.ip_address(a).is_global`
   and not in `100.64.0.0/10`, `169.254.0.0/16`, `fd00::/8`, `::ffff:0:0/96`-mapped private ranges, multicast or
   reserved space. IP-literal hosts get the same check.
4. **Connect to the vetted IP**, not to the hostname again. This defeats DNS rebinding. A custom
   `HTTPSConnection.connect()` opens `socket.create_connection((vetted_ip, port))` and wraps it with
   `ssl.create_default_context().wrap_socket(sock, server_hostname=host)`, so certificate verification still uses the
   hostname.
5. **No redirects** (3xx is an error), 10 s timeouts and a 5 MB response cap.
6. API paths are built from constants plus URL-encoded ids, never from user strings. A GitLab project path in a
   manual-link URL is only used to look up the tracked `Repository`; calls use its numeric `external_id`.

GitHub calls go to fixed hosts (`api.github.com`, `github.com`) through the same client, without resolution
checks.

### 10.5 Least privilege and exposure

- GitHub: the permissions in §2.1 (Contents write only for branch creation; `GITHUB_BRANCH_CREATION=false` allows a
  read-only app). GitLab: `api` only, Maintainer only for hooks; token mode recommends group or project tokens over
  personal ones.
- Tokens and secrets never leave the backend: no endpoint returns them, and `Integration` has no credential fields
  on the wire.
- Webhook payloads are kept for 7 days at most, and only the fields in §3.3 persist on links.
- Non-managers don't see `manageUrl`, nor repositories outside their projects (§5.2).
- IDOR: every integration, repository and link id is resolved through the caller's workspace (404 otherwise). Link
  ids in D3 must belong to the task in the path.
- Rich text is not involved: PR titles and commit messages are rendered as **text**, with only `<mark>` highlighting
  built from React parts (never `innerHTML`).

---

## 11. Conflicts (design vs conventions) and resolutions

| # | Design | Conventions / requirement | Resolution |
|---|---|---|---|
| 1 | One provider at a time: once GitHub connects, the provider tiles disappear | The user requires GitHub **and** GitLab | One status card per connection, followed by tiles for providers not yet connected. A second org of the same provider: "Add organization" in its card. |
| 2 | In-page simulated "Authorize Lightex" dialog with chips `read:repo`, `pull_requests`, `webhooks` | Real OAuth / App install happens on the provider's site | Live: full-page redirect (§9.6). The dialog is kept as the **mock** provider's consent page, with the real permission names as chips. |
| 3 | The repo picker shows every repository of the user's orgs | A GitHub App only sees repositories granted to the installation | The picker lists repositories visible to the installation (or Maintainer+ projects on GitLab), with the footer link "Change access on GitHub". |
| 4 | Roles admin / member / viewer gate everything | Permissions only from `my_permissions` | `integration.manage` (connect, edit repos, reconnect, disconnect, sync); `development.link` (create branch, link, unlink); `project.view` (see Development). |
| 5 | Copy "Admins connect" / "Admin reconnects" | No role names in copy (board 39 #2) | "Can't connect · needs Manage integrations" / "Ask a workspace admin to reconnect". The lock icon and placement are unchanged. |
| 6 | "Sync now" is shown to members, not viewers | It spends the workspace's provider quota; writes need a key | `integration.manage` only (§13 #6). Members see the status without the button. |
| 7 | One error state, "Token expired" | GitHub has no expiring tokens; other failures exist | Error badges per code (§9.7). The layout is the design's. |
| 8 | No repository → project mapping | Repositories shouldn't link into unrelated projects | Default "All projects"; a per-row project scope `Menu` for managers (G10). |
| 9 | Connect GitLab goes straight to authorize | Self-managed instances and tokens are required | "Connect GitLab" opens a `Modal` with GitLab.com (OAuth) and Access token (instance URL + token). |
| 10 | No manual link or unlink | Auto-matching misses some work, and false positives happen | A ⋯ menu "Link pull request or commit…" (URL) and a row menu "Unlink" (with suppression, §6.6). Both need `development.link`. |
| 11 | No automation rules (the brief mentions "move to Done when merged") | Workflow changes must be explicit and per project | Project settings → Development tab with three rules, **all off by default**; done-only target for merges; forward-only guards (§7.10). |
| 12 | Create branch "from main" | Repositories' default branches differ | "from {defaultBranch} in [repo]". Server-side validation (§6.3), 80-character cap (the design's slice). |
| 13 | Branch generator and suggestion via `slug()` (ASCII only, can end with `-`) | Same output on both sides | §9.4: NFKD, hyphen collapse, trailing trim, shared vectors. |
| 14 | Highlight regex hard-coded `/prj-\d+/gi` | Any project key | `highlightKeys` with the workspace's current project keys (old aliases still link on the server, but aren't highlighted). |
| 15 | Hard-coded relative times ("2m", "1h") | Real timestamps | v1 relative-time formatter from ISO times. |
| 16 | Avatar circles with initials and hue | No third-party images (CSP `img-src`) | Matched members use their own avatar and hue; others get initials + `hashHue(login)`. |
| 17 | The Task keys generator picks from three fixed tasks | Real data | The caller's open assigned tasks (first 20); hidden when there are none. |
| 18 | Settings nav order: Profile, Notifications \| Workspace, Members, **Integrations**, Danger zone | v1 nav: General, Members, Roles, Audit log, Trash, Danger zone | "Integrations" goes after Roles; the other items are unchanged. |
| 19 | "Create branch" appends instantly | A remote write can fail | Not optimistic: a spinner on Create, then the flash "Branch created". |
| 20 | Cancel on the first repo picker returns to "Not connected" | A connection already exists server-side after confirm | The client calls `disconnect` on that cancel, which revokes it too. |
| 21 | Counts "4 PRs · 2 branches" | GitLab says MRs | "MRs" when every PR row is GitLab; "PRs" otherwise. |
| 22 | The board chip has failing / open / merged only | Draft PRs exist; closed PRs exist | Draft = muted open chip; closed PRs never headline (§5.7). |
| 23 | `frontend/CLAUDE.md` says board 37 is "planned next, not built" | The user lifted the ban | The frontend updates the bullet and the final report (§9). |

---

## 12. Test plan

### 12.1 Backend (pytest, PostgreSQL; gates unchanged: ruff, mypy, coverage ≥ 85 %, `apps/access` ≥ 95 %)

`INTEGRATIONS_PROVIDER_BACKEND=fake` and `INTEGRATIONS_RUNNER=inline` throughout. The provider adapters are tested
against recorded JSON fixtures (`tests/fixtures/github/*.json`, `gitlab/*.json`) through an injected HTTP stub; no
network.

- **Crypto:** round trip; tampered ciphertext → error; AAD mismatch (copying between rows) → error; decrypt with an
  old `kid` after rotation; `rotate_integration_secrets`; prod settings refuse to start without keys when a provider
  is configured; credentials never appear in any serializer output (assert over every endpoint's JSON).
- **Connect (G2–G6, G12):**
  - state hash stored; expiry at 10 min; single use;
  - `setup_action=request` → `github_requested`;
  - installation not in `/user/installations` → `state_invalid` and nothing created;
  - user token revoked (call recorded);
  - `installation_in_use` across workspaces;
  - confirm checks: wrong user → 404, wrong token → 404, expired → 404, lost `integration.manage` → 404;
  - an expired `called_back` attempt → the pending integration is revoked and deleted by `purge_integrations`;
  - redirect targets are always `FRONTEND_URL/<slug>/…`, and the fragment carries the token;
  - GitLab PKCE verifier round trip;
  - token mode: missing `api` → 422, expired → 422, duplicate account → 409;
  - reconnect with a different account → `account_mismatch`.
- **SSRF (§10.4):**
  - `http://` rejected; userinfo rejected;
  - hosts resolving to `127.0.0.1`, `10.0.0.5`, `169.254.169.254`, `::1`, `fd00::1` and `100.64.0.1` rejected;
  - mixed public/private answers rejected;
  - a DNS-rebinding simulation (first answer public, second private) → the connection uses the vetted IP;
  - a 302 response is an error;
  - an oversized response is cut and errors;
  - `GITLAB_ALLOWED_HOSTS` is enforced.
- **Repositories (G8–G10):**
  - 1–200 limit; unknown id → 422; tracked elsewhere → 422;
  - GitLab hook created with the secret and the right events, and deleted on removal;
  - a hook failure rolls back the whole PUT;
  - re-attaching orphaned links on re-track;
  - project scope validation; non-managers' G1 filtering.
- **Webhooks (W1/W2):**
  - valid signature → 202 and a row; invalid, missing, `sha1=` or wrong-length signatures → 401 and no row;
  - rotated secret list accepted;
  - duplicate `delivery_id` → 200 duplicate and processed once;
  - body over the cap → 413;
  - `ping` → 200;
  - unknown installation → `ignored`; unknown GitLab integration → 404; wrong `X-Gitlab-Instance` → 401;
  - the receiver makes **zero** outbound calls and zero task writes (assert with the HTTP stub and the query log);
  - receiver latency: ≤ 15 queries.
- **Matching (§6, shared vectors §12.3):**
  - aliases (retired prefix → current project; old prefix + new number);
  - other workspace's key ignored; deleted task ignored; archived project linked but no automation;
  - repository scope respected;
  - 10-key cap; 200-link cap with `link_cap`;
  - title edit adds and removes auto links but never manual ones; suppression survives re-delivery; D2 re-link
    clears it.
- **Processing:**
  - out-of-order `pull_request` events (older `updated_at` ignored);
  - checks keyed by head sha, and a new sha clears them;
  - aggregate failing > running > passing; GitLab `allow_failure`;
  - approvals refetch;
  - `ahead_by` skipped under a low rate budget;
  - GitLab `total_commits_count > 20` triggers one compare call;
  - lease reclaim after 120 s; 5 attempts → `failed`;
  - thread runner: one drain thread per process under 50 concurrent inserts;
  - `SKIP LOCKED` keeps two drains from double-processing (two connections in a `TransactionTestCase`).
- **Backfill/sync:**
  - limits honoured (PR cap, branches page cap, commits since, 120-request budget → `partial`);
  - backfill: no automations, no notifications, one summary audit row;
  - incremental sync runs automations for missed merges;
  - `sync_one_active`; G11's 2-minute rule → 429 with `Retry-After`;
  - deferral on `X-RateLimit-Remaining` < 200 and on `Retry-After`;
  - catch-up: GitHub redelivers only unknown failed deliveries of this installation; GitLab re-enables disabled
    hooks.
- **Automation (§7.10):**
  - `pr_merged` → Done: version bump, `TaskStatusHistory.changed_by` NULL, `completed_at`;
  - audit row with `actor_kind="integration"`, `actor_ref`, `actor_name="GitHub"`, `source="webhook"`;
  - `status_change` notification to assignee and reporter with `payload.via="github"`;
  - not applied when another linked PR is open, the task is already done, the project is archived, the rule is off,
    or the link is suppressed;
  - `pr_opened` only from the todo category;
  - A2 validation (done-only target for merges).
- **Development endpoints:**
  - D1 shape and ordering, caps, `repository: null` after disconnect, `suggestedBranch` vectors;
  - D2 URL parsing for every form in the table, untracked → 422, other project → 422, provider 404 → 422,
    idempotent re-link → 200;
  - D3 manual delete vs suppression; link id from another task → 404;
  - D4 name validation vectors, 409 `branch_exists`, archived repository, `GITHUB_BRANCH_CREATION=false`,
    `branch_created` automation, throttle.
- **Disconnect (G13):**
  - 204; links kept with `repository` NULL; deliveries ignored; runs failed;
  - provider calls: GitHub uninstall; GitLab hooks deleted and OAuth revoked; bot token self-revoked; PAT **not**
    revoked;
  - credentials wiped before delete; `revoked=false` recorded when the provider fails.
- **Permissions:**
  - new rows in `apps/access/tests/matrix_rows.py` for every endpoint × the seven default roles × a non-member
    (G-endpoints by workspace role; D/A by project role);
  - IDOR rows in `test_idor.py` (integration, repository and link ids across workspaces);
  - `my_permissions` order (§4.3); data migration idempotency.
- **Payloads:**
  - `Task.dev` headline rule (open beats merged; merged older than 14 days → null; closed never);
  - **constant query count** for board, list and backlog with 0, 1 and 50 linked tasks;
  - `Project.devEnabled`.
- **Realtime (if board 33 is present):** `task.changed` with `fields ["development"]` and `version null`;
  `integration.changed` delivered to a member without project access; `tasks.bulk_changed` after backfill.
- **Commands:** `fake_webhook` end to end through the real verifier; `process_integrations`;
  `purge_integrations` (deliveries older than 7 days, expired attempts).
- **OpenAPI:** regenerated; drift check passes.

### 12.2 Frontend (`npm run check`; Vitest with `--maxWorkers=2` on this machine)

- **Unit:**
  - `key-match.ts` and `branch-name.ts` against the shared vectors;
  - `hashHue`;
  - check-state aggregation;
  - the board chip's tooltip/aria text builder;
  - the PR/MR count label;
  - `parseConnectFragment` (valid, malformed, error codes).
- **Mock handlers:**
  - G1 filtering for non-managers;
  - G2 → `#mock-authorize` → confirm → picker;
  - G9 limits and errors; G11 2-minute 429; G13 keeps links;
  - D1–D4 parity with §5.6 (codes and copy);
  - automation through the dev-pill "Merge PR" (status change, audit row with `actorKind: "integration"`,
    notification `via`);
  - permission denials per seeded user.
- **Components (Testing Library):**
  - `IntegrationsScreen` states: loading skeleton, error + retry, not connected, connected, error card per code,
    unavailable provider (`disabledReason`), lock note without the key;
  - `RepoPicker`: search, org select-all tri-state, no-match + clear, confirm disabled at 0, first-time cancel
    disconnects, `trackedElsewhere` disabled;
  - `DisconnectDialog`: focus on Cancel, Esc closes;
  - `GitLabConnectDialog` field errors;
  - `DevelopmentSection`: loading / empty / ready / error, checks expand (`aria-expanded`), Create branch
    validation, 409 inline, unlink + Undo, hidden controls for `u_taylor` (Viewer);
  - project settings Development tab: read-only for Sam, editable for Alex;
  - task card chip variants.
- **Gating per seeded user** on `platform`:
  - `u_alex` (Owner): everything;
  - `u_jordan` (Admin + Manager on PRJ): everything;
  - `u_sam` (Member): no manage, can create branches and link;
  - `u_taylor` (Viewer on PRJ): sees the section, no actions;
  - `u_casey` (Admin, not on PRJ): manages integrations but gets the 403 screen on PRJ tasks.
- **e2e (`e2e/smoke.spec.ts` additions):**
  - as Alex in mock mode: Settings → Integrations → Connect GitHub → Authorize → pick 4 → toast "GitHub connected ·
    4 repos" (after a data reset that removes the seeded integration via the dev control);
  - open `PRJ-42` → Development shows "4 PRs · 2 branches", expand #214's checks, Create branch → "Branch created";
  - the board shows the `#214` failing chip.
- **Visual:**
  - screenshots at 1440 and 390, navy/black/light, as `u_alex` and `u_taylor`: the integrations page (connected,
    error), the picker, the task panel with Development, empty Development;
  - no console errors.

### 12.3 Shared vectors (`docs/v2/vectors/37-dev.json`, read by both test suites)

| Input | Expected |
|---|---|
| keys in `prj-42-fix-reflow` (prefixes PRJ) | `["PRJ-42"]` |
| `fix(board): debounce reflow (PRJ-42)` | `["PRJ-42"]` |
| `feature/PRJ-42_x and prj-43` | `["PRJ-42","PRJ-43"]` |
| `XPRJ-42`, `PRJ-42a`, `PRJ-042`, `PRJ-` | `[]` |
| `UTF-8 and SHA-256` (prefixes PRJ, MOB) | `[]` |
| `[PRJ-1] PRJ-1 PRJ-2` | `["PRJ-1","PRJ-2"]` (dedupe, order) |
| 12 distinct keys | the first 10 |
| `suggestBranch("PRJ-42","Fix flaky board reflow on column resize")` | `prj-42-fix-flaky-board-reflow` |
| `suggestBranch("PRJ-58","Write release notes for 2.4")` | `prj-58-write-release-notes-24` |
| `suggestBranch("PRJ-52","Rate-limit login attempts","feature/")` | `feature/prj-52-rate-limit-login-attempts` |
| `suggestBranch("PRJ-7","Résumé — the café")` | `prj-7-resume-cafe` |
| `suggestBranch("PRJ-9","!!!")` | `prj-9` |
| `validateBranch`: `a..b`, `-x`, `x/`, `x.lock`, `a//b`, `a@{b`, 81 characters, `a b` | invalid |
| `validateBranch`: `feature/prj-42-x`, `prj-42.fix_1` | valid |
| checks `[fail, pass]` / `[run, pass]` / `[pass, pass]` / `[]` | `failing` / `running` / `passing` / `null` |

---

## 13. Open questions

None blocks implementation; each has a default that both sides build to. Confirm or change before release:

1. **GitHub Enterprise Server.** Default: not supported. The provider already takes `base_url`, so adding it means
   per-instance app credentials.
2. **Self-managed GitLab via OAuth.** Default: token mode only. The OAuth app in `GITLAB_*` can point at **one**
   self-managed instance (`GITLAB_BASE_URL`) instead of gitlab.com, but not both. Per-instance OAuth apps would
   need admin-entered client credentials (stored encrypted).
3. **Scan PR/MR descriptions for keys** ("Closes PRJ-42")? Default: no; title and branch only, to avoid false
   links from templates and quoted text.
4. **Automation defaults.** Default: all rules off. Alternative: turn on `pr_merged → first Done status` for new
   projects.
5. **Revoking pasted personal access tokens on disconnect.** Default: only bot (group/project) tokens are revoked;
   personal tokens are wiped locally, because they may be used elsewhere.
6. **"Sync now" for non-admins** (the design shows it to members). Default: `integration.manage` only.
7. **Repository names visible to every workspace member** on the Integrations page. Default: yes, filtered by
   project scope.
8. **Notifications** for "your PR merged" or integration errors. Default: none (no workspace-level notification
   type exists). Adding them needs a notification type, an inbox row design and a preference.
9. **Render free plan.** Webhooks that arrive while the service sleeps fail and aren't retried by the providers.
   The catch-up path (§7.6) restores the data the next time someone opens the app, but automations then fire late.
   Recommendation: a paid instance, or a cron running `process_integrations` every 5 min.
10. **Branch creation needs GitHub Contents: write.** Default: on. A security-sensitive org can run with
    `GITHUB_BRANCH_CREATION=false` and a read-only app.
11. **Multiple GitHub orgs.** Default: one integration per installation; the workspace can hold several. Confirm
    that the "Add organization" link (rather than a merged single card) is acceptable visually.

---

## 14. Delivery checklist

**Backend:**

- `apps/integrations` (models, migrations, providers, http + SSRF guard, crypto, matching, processor, runner,
  automation, views, URLs, commands);
- `tasks.ExternalLink` migration; `audit` actor columns; `access` data migration; catalogue and default roles;
- `Task.dev` / `Project.devEnabled` with constant query counts; activity verbs and `activity_data` fields;
  notification `via`;
- realtime events (if board 33 has landed); `cryptography` pinned;
- settings and env (`.env.example`, `render.yaml`, README: GitHub App and GitLab setup from §2); `seed_demo` fake
  data;
- tests (§12.1); `docs/openapi.yaml` regenerated; `docs/backend-final-report.md` updated (dependency, deviations,
  setup).

**Frontend:**

- the `CLAUDE.md` scope bullet; types, `endpoints.ts`, `qk`; permissions catalogue and order;
- the settings route and nav; `features/integrations/*`; `features/development/*`; the board and list chip; the
  project settings Development tab;
- activity, inbox and audit text; mock handlers, seed and dev-pill controls;
- shared vectors; tests (§12.2); the `final-report.md` entries (requested API additions, conflicts, §8 status).
