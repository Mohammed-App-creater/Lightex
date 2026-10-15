"""Provider-shaped webhook payloads and signed requests (`manage.py fake_webhook`, tests). §7.8."""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from django.utils import timezone

from .models import Integration, Repository
from .providers.base import github_secrets, sign_github
from .providers.fake import FAKE_WEBHOOK_SECRET

EVENTS = ("pr_opened", "pr_merged", "checks_failed", "push")


def demo_sha(key: str) -> str:
    return hashlib.sha1(key.encode(), usedforsecurity=False).hexdigest()


def demo_number(key: str) -> int:
    return 500 + int(demo_sha(key)[:4], 16) % 400


def github_payload(repo: Repository, integration: Integration, event: str, key: str) -> tuple[str, dict[str, Any]]:
    now = timezone.now().isoformat()
    sha, number, branch = demo_sha(key), demo_number(key), f"{key.lower()}-demo"
    repository = {"id": int(repo.external_id), "full_name": repo.full_path, "html_url": repo.web_url}
    installation = {"id": int(integration.account_external_id)}
    if event in ("pr_opened", "pr_merged"):
        merged = event == "pr_merged"
        pr = {
            "number": number,
            "title": f"{key} Demo change",
            "state": "closed" if merged else "open",
            "merged": merged,
            "merged_at": now if merged else None,
            "closed_at": now if merged else None,
            "draft": False,
            "head": {"ref": branch, "sha": sha},
            "base": {"ref": repo.default_branch},
            "html_url": f"{repo.web_url}/pull/{number}",
            "user": {"login": "akim"},
            "created_at": now,
            "updated_at": now,
        }
        action = "closed" if merged else "opened"
        return "pull_request", {"action": action, "number": number, "pull_request": pr, "repository": repository,
                                "installation": installation}  # fmt: skip
    if event == "checks_failed":
        run = {"name": "ci / tests", "status": "completed", "conclusion": "failure", "head_sha": sha,
               "started_at": now, "completed_at": now, "html_url": f"{repo.web_url}/runs/1"}  # fmt: skip
        return "check_run", {"action": "completed", "check_run": run, "repository": repository,
                             "installation": installation}  # fmt: skip
    commit = {
        "id": sha,
        "message": f"fix: demo change ({key})",
        "timestamp": now,
        "url": f"{repo.web_url}/commit/{sha}",
        "author": {"name": "Alex Kim", "email": "alex@team.dev", "username": "akim"},
    }
    return "push", {"ref": f"refs/heads/{branch}", "before": "0" * 40, "after": sha, "deleted": False,
                    "commits": [commit], "head_commit": commit, "repository": repository,
                    "installation": installation}  # fmt: skip


def gitlab_payload(repo: Repository, event: str, key: str) -> tuple[str, dict[str, Any]]:
    now = timezone.now().isoformat()
    sha, number, branch = demo_sha(key), demo_number(key), f"{key.lower()}-demo"
    project = {"id": int(repo.external_id), "web_url": repo.web_url, "path_with_namespace": repo.full_path}
    if event in ("pr_opened", "pr_merged"):
        merged = event == "pr_merged"
        attrs = {
            "iid": number,
            "title": f"{key} Demo change",
            "state": "merged" if merged else "opened",
            "action": "merge" if merged else "open",
            "source_branch": branch,
            "target_branch": repo.default_branch,
            "last_commit": {"id": sha},
            "url": f"{repo.web_url}/-/merge_requests/{number}",
            "created_at": now,
            "updated_at": now,
        }
        user = {"username": "akim", "name": "Alex Kim"}
        return "Merge Request Hook", {"object_kind": "merge_request", "user": user, "project": project,
                                      "object_attributes": attrs}  # fmt: skip
    if event == "checks_failed":
        builds = [{"name": "ci / tests", "status": "failed", "duration": 42.0, "allow_failure": False}]
        return "Pipeline Hook", {"object_kind": "pipeline", "object_attributes": {"sha": sha, "status": "failed"},
                                 "builds": builds, "project": project}  # fmt: skip
    commit = {
        "id": sha,
        "message": f"fix: demo change ({key})",
        "timestamp": now,
        "url": f"{repo.web_url}/-/commit/{sha}",
        "author": {"name": "Alex Kim", "email": "alex@team.dev"},
    }
    return "Push Hook", {"object_kind": "push", "ref": f"refs/heads/{branch}", "before": "0" * 40, "after": sha,
                         "commits": [commit], "total_commits_count": 1, "project": project}  # fmt: skip


def post(client: Any, integration: Integration, event: str, payload: dict[str, Any], **extra: Any) -> Any:
    """Signs with the real scheme and posts through a Django/DRF test client."""
    body = json.dumps(payload).encode()
    delivery = extra.pop("delivery", None) or str(uuid.uuid4())
    if integration.provider == "github":
        secret = (github_secrets() or [FAKE_WEBHOOK_SECRET])[0]
        headers = {
            "HTTP_X_GITHUB_EVENT": event,
            "HTTP_X_GITHUB_DELIVERY": delivery,
            "HTTP_X_HUB_SIGNATURE_256": sign_github(body, secret),
        }
        url = "/api/v1/webhooks/github"
    else:
        headers = {
            "HTTP_X_GITLAB_EVENT": event,
            "HTTP_X_GITLAB_EVENT_UUID": delivery,
            "HTTP_X_GITLAB_TOKEN": integration.get_secret("webhook_secret"),
        }
        url = f"/api/v1/webhooks/gitlab/{integration.pk}"
    headers.update(extra)
    return client.generic("POST", url, body, content_type="application/json", **headers)
