"""Board 40 test fixtures: the design's 48-row sample (a port of the mock's `sampleText()`), the Jira export, and a
PRJ-like world (statuses of the scrum template, Alex/Riley/Sam/Jordan, the seed labels, task_seq 60)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from apps.collaboration.storage import get_storage
from apps.common.testing import UserFactory, add_project_member, client_for, make_project, make_workspace

DATA = Path(__file__).parent / "data"
VECTORS: dict[str, Any] = json.loads((DATA / "import_vectors.json").read_text(encoding="utf-8"))
JIRA = (DATA / "jira-export.csv").read_bytes()

TITLES = [
    "Fix login redirect loop", "Add SSO for admin console", "Board loads slowly with 500 cards",
    "Rate-limit password reset", "Dark mode for settings", "Export sprint report as PDF",
    "Flaky test: drag between columns", "Webhook retries with backoff", "Keyboard shortcut cheatsheet",
    "Archive closed sprints", "Paginate activity feed", "Mobile: offline task cache", "Audit log for role changes",
    "Invite flow email copy", "Bulk edit priority", "Search by task key", "Billing: proration on seat change",
    "Upgrade to Node 22", "Remove legacy v1 endpoints", "Attachment virus scan", "Due date reminders",
    "Burndown off by one day", "Slack notifications digest", "Custom fields on cards",
    "Reduce bundle size under 300 KB", "Timezone bug in due dates", "Retry failed uploads", "Sticky table headers",
    "Onboarding checklist", "Two-factor recovery codes",
]  # fmt: skip


def _cell(v: str) -> str:
    return '"' + v.replace('"', '""') + '"' if re.search(r'[",\n\r;]', v) else v


def sample_text(rows: int = 48) -> str:
    """A port of the mock's sampleText() (48 rows = data/sample.csv); `rows` > 48 repeats the pattern."""
    st = ["todo", "in progress", "todo", "done", "review", "in progress", "blocked"]
    people = ["Alex Kim", "Riley Chen", "Sam Patel", "Chris Ortiz", ""]
    pr = ["High", "Medium", "Low", "Urgent", "Medium", ""]
    es = ["3", "2", "5", "1", "8", ""]
    tags = ["frontend", "backend", "frontend;perf", "", "api"]
    ds = ["Repro in Safari 17", "See incident 112", "", 'Spec in "Billing v2" doc', ""]
    lines = [",".join(["Title", "Description", "Status", "Assignee", "Priority", "Estimate", "Due", "Tags"])]
    for i in range(rows):
        title = "" if i in (6, 40) else TITLES[i % 30] + (" (follow-up)" if i >= 30 else "")
        due = "next week" if i == 18 else "" if i % 4 == 3 else f"2026-10-{8 + (i % 20):02d}"
        est = "XL" if i == 25 else es[i % 6]
        cells = [title, ds[i % 5], st[i % 7], people[i % 5], pr[i % 6], est, due, tags[i % 5]]
        lines.append(",".join(_cell(c) for c in cells))
    return "\r\n".join(lines) + "\r\n"


# The design's sample, generated from the web client's `src/lib/mock/import/fixtures/sample.ts` (byte-for-byte).
SAMPLE = (DATA / "sample.csv").read_bytes()


class World:
    def __init__(self) -> None:
        from apps.planning.models import Sprint
        from apps.projects.models import Label

        self.alex = UserFactory(name="Alex Kim", email="alex@team.dev")
        self.ws = make_workspace(self.alex, name="Platform team", slug="platform")
        self.project = make_project(self.ws, self.alex, key="PRJ", name="Platform Rebuild", template="scrum")
        self.riley = add_project_member(self.project, UserFactory(name="Riley Chen", email="riley@team.dev"))
        self.sam = add_project_member(self.project, UserFactory(name="Sam Patel", email="sam@team.dev"))
        self.jordan = add_project_member(self.project, UserFactory(name="Jordan Lee", email="jordan@team.dev"))
        self.taylor = add_project_member(
            self.project, UserFactory(name="Taylor Fox", email="taylor@team.dev"), key="viewer"
        )
        for name in ("perf", "infra"):
            Label.objects.create(project=self.project, name=name)
        self.project.task_seq = 60
        self.project.save(update_fields=["task_seq"])
        self.sprint = Sprint.objects.create(
            project=self.project, name="Sprint 14", number=14, start_date="2026-10-05", end_date="2026-10-18"
        )

    def status(self, name: str):
        return self.project.statuses.get(name=name)

    def client(self, user=None):
        return client_for(user or self.alex)


def create(client, project, *, name: str = "tasks-export.csv", size: int | None = 10, source: str = "csv"):
    return client.post(f"/api/v1/projects/{project.id}/imports", {"source": source, "fileName": name, "size": size})


def upload(job: dict[str, Any], data: bytes) -> None:
    from apps.imports.models import ImportJob

    key = ImportJob.objects.get(pk=job["id"]).source_key
    get_storage().put(key, data, "text/csv")  # type: ignore[attr-defined]


def analyzed(client, project, data: bytes, *, name: str = "tasks-export.csv", source: str = "csv") -> dict[str, Any]:
    """I1 → PUT the bytes → I2. Returns the analysed job (asserts 200)."""
    res = create(client, project, name=name, size=len(data), source=source)
    assert res.status_code == 201, res.content
    job = res.json()["job"]
    upload(job, data)
    res = client.post(f"/api/v1/imports/{job['id']}/analyze")
    assert res.status_code == 200, res.content
    return res.json()


def save_mapping(client, job: dict[str, Any], **changes: Any):
    mapping = dict(job["mapping"])
    mapping.update(changes)
    mapping["revision"] = job["mapping"]["revision"] + 1
    return client.put(f"/api/v1/imports/{job['id']}/mapping", mapping)


def start(client, job: dict[str, Any]):
    return client.post(f"/api/v1/imports/{job['id']}/start")


def mapped_sample(world: World) -> dict[str, Any]:
    """The sample, analysed, with `blocked` mapped to Todo (ready to start)."""
    client = world.client()
    job = analyzed(client, world.project, SAMPLE)
    res = save_mapping(client, job, statuses={"blocked": str(world.status("Todo").id)})
    assert res.status_code == 200, res.content
    return res.json()
