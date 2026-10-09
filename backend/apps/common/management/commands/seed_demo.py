"""Demo data equivalent to the web client's mock seed (development only).

Loads apps/common/fixtures/demo_seed.json, which is exported from frontend/src/lib/mock/seed.ts (see
scripts/frontend-seed/). IDs become UUIDs and every date is shifted so the data looks current.
Status history is synthesised from each task's started/completed timestamps so reports have data.

    python manage.py seed_demo            # refuses if the demo workspace already exists
    python manage.py seed_demo --flush    # deletes the demo workspaces and users first

Board 39 (custom fields, dependencies, time) is loaded from the fixture's `customFields`, `dependencies` and
`timeEntries` collections when present; otherwise the same PRJ data is built here from
docs/v2/39-fields-dependencies-time.md §6.8.

Board 32 (timeline & calendar) start dates and epic dates are read from the fixture's `startDate` / `dueDate` keys
when present; then `load_board32` applies the mock's `ensureExt32` upgrade (docs/v2/32-timeline-calendar.md §6.9)
with the same rules, so an older fixture gets the same PRJ dates as mock mode.

Every demo account uses DEMO_PASSWORD. The command refuses to run when DEBUG is off.
"""

from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from apps.access.models import Permission, Role, RolePermission
from apps.access.services import seed_default_roles
from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.collaboration.models import Comment, CommentMention
from apps.common.richtext import doc_text
from apps.common.tokens import new_token
from apps.notifications.models import Notification
from apps.planning.models import Epic, Milestone, Objective, Sprint
from apps.projects.models import (
    CustomField,
    CustomFieldOption,
    Label,
    Project,
    ProjectKeyAlias,
    ProjectMember,
    SavedView,
    Status,
    ViewPin,
)
from apps.tasks.models import (
    Task,
    TaskDependency,
    TaskFieldValue,
    TaskLabel,
    TaskObjective,
    TaskStatusHistory,
)
from apps.tasks.services import refresh_search_vector
from apps.timetracking.models import TimeEntry
from apps.workspaces.models import Invitation, Workspace, WorkspaceMember

DEMO_PASSWORD = "Lightex-demo-2026"
FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "demo_seed.json"
ANCHOR = dt.date(2026, 10, 7)
ACTIVITY_ACTIONS = {
    "created": "task.created",
    "status_changed": "task.status_changed",
    "assigned": "task.assigned",
    "commented": "comment.created",
    "linked_objective": "task.objective_linked",
    "updated": "task.updated",
    "sprint_started": "sprint.started",
    "sprint_completed": "sprint.completed",
    "attached": "attachment.created",
    "member_added": "project_member.added",
}


class Command(BaseCommand):
    help = "Create demo data matching the web client's mock data (DEBUG only)."

    def add_arguments(self, parser):
        parser.add_argument("--flush", action="store_true", help="Delete existing demo workspaces and users first")

    def handle(self, *args, **options):
        if not settings.DEBUG:
            raise CommandError("seed_demo only runs with DEBUG=True (it creates accounts with a known password).")
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.shift = timezone.now().date() - ANCHOR
        slugs = [w["slug"] for w in data["workspaces"]]
        emails = [u["email"] for u in data["users"]]
        with transaction.atomic():
            if options["flush"]:
                from apps.audit.trash import purge_workspace

                for ws in Workspace.all_objects.filter(slug__in=slugs):
                    purge_workspace(ws)
                User.objects.filter(email__in=emails).delete()
            elif Workspace.all_objects.filter(slug__in=slugs).exists():
                raise CommandError("Demo data already exists. Run with --flush to recreate it.")
            self.load(data)
        self.report(data)

    # ── date helpers ──

    def date(self, value: str | None) -> dt.date | None:
        return dt.date.fromisoformat(value) + self.shift if value else None

    def day(self, value: str) -> dt.date:
        return dt.date.fromisoformat(value) + self.shift

    def moment(self, value: str) -> dt.datetime:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")) + self.shift

    def ts(self, value: str | None) -> dt.datetime | None:
        if not value:
            return None
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")) + self.shift

    # ── loading ──

    def load(self, data: dict[str, Any]) -> None:
        self.users = {}
        for u in data["users"]:
            user = User(email=u["email"], name=u["name"], hue=u["hue"])
            user.set_password(DEMO_PASSWORD)
            user.created_at = self.ts(u["createdAt"]) or timezone.now()
            user.save()
            self.users[u["id"]] = user
        perms = {p.code: p for p in Permission.objects.all()}
        self.workspaces, self.roles = {}, {}
        for w in data["workspaces"]:
            ws = Workspace.objects.create(
                slug=w["slug"], name=w["name"], hue=w["hue"], created_at=self.ts(w["createdAt"])
            )
            self.workspaces[w["id"]] = ws
            for key, role in seed_default_roles(ws).items():
                self.roles[f"{w['id']}-role-{key}"] = role
        for r in data["roles"]:
            if r["isSystem"]:
                continue
            role = Role.objects.create(
                workspace=self.workspaces[r["workspaceId"]],
                name=r["name"],
                description=r["description"],
                scope=r["scope"],
            )
            RolePermission.objects.bulk_create(
                [RolePermission(role=role, permission=perms[c]) for c in r["permissions"]]
            )
            self.roles[r["id"]] = role
        for m in data["wsMembers"]:
            WorkspaceMember.objects.create(
                workspace=self.workspaces[m["workspaceId"]],
                user=self.users[m["userId"]],
                role=self.roles[m["roleId"]],
                status=m["status"],
                joined_at=self.moment(m["joinedAt"]),
                last_active_at=self.ts(m["lastActiveAt"]),
            )
        self.load_projects(data)
        self.load_planning(data)
        self.load_tasks(data)
        self.load_board39(data)
        self.load_board32()
        self.load_collaboration(data)

    def load_projects(self, data: dict[str, Any]) -> None:
        self.projects, self.statuses, self.labels = {}, {}, {}
        for p in data["projects"]:
            project = Project.objects.create(
                workspace=self.workspaces[p["workspaceId"]],
                key=p["key"],
                name=p["name"],
                description=p["description"],
                hue=p["hue"],
                lead=self.users.get(p["leadId"]),
                status=p["status"],
                template=p["template"],
                task_seq=p["taskSeq"],
                created_at=self.ts(p["createdAt"]),
            )
            ProjectKeyAlias.objects.create(workspace=project.workspace, project=project, key=project.key)
            self.projects[p["id"]] = project
        for s in data["statuses"]:
            self.statuses[s["id"]] = Status.objects.create(
                project=self.projects[s["projectId"]],
                name=s["name"],
                category=s["category"],
                glyph=s["glyph"],
                position=s["position"],
            )
        for lb in data["labels"]:
            self.labels[lb["id"]] = Label.objects.create(
                project=self.projects[lb["projectId"]], name=lb["name"], color=lb["color"]
            )
        for m in data["projectMembers"]:
            ProjectMember.objects.create(
                project=self.projects[m["projectId"]],
                user=self.users[m["userId"]],
                role=self.roles[m["roleId"]],
                added_at=self.moment(m["addedAt"]),
            )

    def load_planning(self, data: dict[str, Any]) -> None:
        self.objectives, self.milestones, self.epics, self.sprints = {}, {}, {}, {}
        for o in data["objectives"]:
            self.objectives[o["id"]] = Objective.objects.create(
                project=self.projects[o["projectId"]],
                title=o["title"],
                description=o["description"],
                owner=self.users.get(o["ownerId"]),
                quarter=o["quarter"],
                due_date=self.date(o["dueDate"]),
                status=o["status"],
                created_at=self.moment(o["createdAt"]),
            )
        for m in data["milestones"]:
            self.milestones[m["id"]] = Milestone.objects.create(
                project=self.projects[m["projectId"]],
                name=m["name"],
                description=m["description"],
                owner=self.users.get(m["ownerId"]),
                start_date=self.day(m["startDate"]),
                due_date=self.day(m["dueDate"]),
                completed_at=self.ts(m["completedAt"]),
            )
        for e in data["epics"]:
            self.epics[e["id"]] = Epic.objects.create(
                project=self.projects[e["projectId"]],
                name=e["name"],
                description=e["description"],
                hue=e["hue"],
                owner=self.users.get(e.get("ownerId")),
                milestone=self.milestones.get(e.get("milestoneId")),
                archived_at=self.ts(e.get("archivedAt")),
                start_date=self.date(e.get("startDate")),
                due_date=self.date(e.get("dueDate")),
            )
        for s in data["sprints"]:
            start, end = self.day(s["startDate"]), self.day(s["endDate"])
            self.sprints[s["id"]] = Sprint.objects.create(
                project=self.projects[s["projectId"]],
                name=s["name"],
                number=s["number"],
                goal=s["goal"],
                start_date=start,
                end_date=end,
                state=s["state"],
                completed_at=self.ts(s["completedAt"]),
                started_at=dt.datetime.combine(start, dt.time(9), tzinfo=dt.UTC) if s["state"] != "planned" else None,
            )

    def load_tasks(self, data: dict[str, Any]) -> None:
        self.tasks: dict[str, Task] = {}
        pending_parents = []
        by_project: dict[str, list[Status]] = {}
        for s in self.statuses.values():
            by_project.setdefault(str(s.project_id), []).append(s)
        for t in data["tasks"]:
            status = self.statuses[t["statusId"]]
            task = Task.objects.create(
                project=self.projects[t["projectId"]],
                number=t["number"],
                key=t["key"],
                title=t["title"],
                description=t["description"],
                type=t["type"],
                priority=t["priority"],
                status=status,
                assignee=self.users.get(t["assigneeId"]),
                reporter=self.users.get(t["reporterId"]),
                estimate=t["estimate"],
                start_date=self.date(t.get("startDate")),
                due_date=self.date(t["dueDate"]),
                epic=self.epics.get(t["epicId"]),
                milestone=self.milestones.get(t["milestoneId"]),
                sprint=self.sprints.get(t["sprintId"]),
                position=t["position"],
                version=t["version"],
                created_at=self.ts(t["createdAt"]),
                started_at=self.ts(t.get("startedAt")),
                completed_at=self.ts(t.get("completedAt")),
                deleted_at=self.ts(t.get("deletedAt")),
            )
            self.tasks[t["id"]] = task
            if t["parentId"]:
                pending_parents.append((task, t["parentId"]))
            TaskObjective.objects.bulk_create(
                [TaskObjective(task=task, objective=self.objectives[o]) for o in t["objectiveIds"]]
            )
            TaskLabel.objects.bulk_create([TaskLabel(task=task, label=self.labels[lb]) for lb in t["labelIds"]])
            self.history(task, by_project[str(task.project_id)])
            refresh_search_vector(task)
        for task, parent_id in pending_parents:
            task.parent = self.tasks[parent_id]
            task.save(update_fields=["parent"])
        for sprint in self.sprints.values():
            if sprint.state != "planned":
                live = [t for t in self.tasks.values() if t.sprint_id == sprint.pk and t.status.glyph != "canceled"]
                sprint.committed_points = sum(t.estimate or 0 for t in live)
                sprint.committed_count = len(live)
                sprint.save(update_fields=["committed_points", "committed_count"])

    def history(self, task: Task, statuses: list[Status]) -> None:
        """created → (in progress at started_at) → (current status at completed_at / started_at)."""
        first = {s.category: s for s in sorted(statuses, key=lambda s: -s.position)}
        todo = next(s for s in sorted(statuses, key=lambda s: s.position) if s.glyph == "todo" or s.category == "todo")
        progress = next(
            (s for s in sorted(statuses, key=lambda s: s.position) if s.category == "in_progress"),
            first.get("in_progress"),
        )
        rows: list[tuple[Status | None, Status, dt.datetime]] = []
        current = task.status
        initial = current if (current.category == "todo" or not task.started_at) and not task.completed_at else todo
        rows.append((None, initial, task.created_at))
        previous = initial
        if task.started_at and progress and previous.pk != progress.pk:
            rows.append((previous, progress, task.started_at))
            previous = progress
        if previous.pk != current.pk:
            at = task.completed_at or task.started_at or task.created_at
            rows.append((previous, current, at))
        # Keep the history strictly ordered even when the source timestamps coincide.
        for i in range(1, len(rows)):
            if rows[i][2] <= rows[i - 1][2]:
                rows[i] = (rows[i][0], rows[i][1], rows[i - 1][2] + dt.timedelta(hours=1))
        TaskStatusHistory.objects.bulk_create(
            [
                TaskStatusHistory(
                    task=task,
                    from_status=a,
                    to_status=b,
                    from_category=a.category if a else None,
                    to_category=b.category,
                    changed_by=task.assignee or task.reporter,
                    at=at,
                )
                for a, b, at in rows
            ]
        )

    def _remap_mentions(self, node: Any) -> Any:
        if isinstance(node, dict):
            out = {k: self._remap_mentions(v) for k, v in node.items()}
            if out.get("type") == "mention" and isinstance(out.get("attrs"), dict):
                user = self.users.get(out["attrs"].get("id"))
                out["attrs"] = {**out["attrs"], "id": str(user.pk) if user else out["attrs"].get("id")}
            return out
        if isinstance(node, list):
            return [self._remap_mentions(v) for v in node]
        return node

    def load_collaboration(self, data: dict[str, Any]) -> None:
        for c in data["comments"]:
            body = self._remap_mentions(c["body"])
            comment = Comment.objects.create(
                task=self.tasks[c["taskId"]],
                author=self.users.get(c["authorId"]),
                body=body,
                body_text=doc_text(body),
                created_at=self.ts(c["createdAt"]),
                edited_at=self.ts(c["editedAt"]),
            )
            CommentMention.objects.bulk_create(
                [CommentMention(comment=comment, user=self.users[m]) for m in c["mentions"] if m in self.users]
            )
        for n in data["notifications"]:
            project = self.projects[n["projectId"]]
            Notification.objects.create(
                recipient=self.users[n["recipientId"]],
                workspace=project.workspace,
                project=project,
                task=self.tasks.get(n["taskId"]),
                type=n["type"],
                actor=self.users.get(n["actorId"]),
                payload=n["payload"],
                created_at=self.moment(n["createdAt"]),
                read_at=self.ts(n["readAt"]),
            )
        for a in data["activity"]:
            project = self.projects[a["projectId"]]
            task = self.tasks.get(a["taskId"]) if a.get("taskId") else None
            actor = self.users.get(a["actorId"])
            action = ACTIVITY_ACTIONS.get(a["verb"], "task.updated")
            AuditLog.objects.create(
                workspace=project.workspace,
                project=project,
                task=task,
                actor=actor,
                actor_name=actor.name if actor else "",
                action=action,
                entity_type=action.split(".")[0],
                entity_id=str(task.pk) if task else "",
                entity_key=task.key if task else None,
                target=task.title if task else project.name,
                task_key=task.key if task else None,
                task_title=task.title if task else None,
                data=a.get("data") or {},
                created_at=self.moment(a["createdAt"]),
            )
        self.invite_links = []
        for inv in data["invites"]:
            raw, digest = new_token()
            Invitation.objects.create(
                workspace=self.workspaces[inv["workspaceId"]],
                email=inv["email"],
                role=self.roles[inv["roleId"]],
                invited_by=self.users.get(inv["invitedById"]),
                token_hash=digest,
                expires_at=timezone.now() + dt.timedelta(days=7),
            )
            self.invite_links.append((inv["email"], f"{settings.FRONTEND_URL}/invite/{raw}"))
        self.saved_views()

    def saved_views(self) -> None:
        """Two personal pinned views per member in their first visible project (as in the mock)."""
        for member in WorkspaceMember.objects.select_related("workspace", "user"):
            if member.workspace.slug not in ("platform", "design-guild"):
                continue
            pm = (
                ProjectMember.objects.filter(user=member.user, project__workspace=member.workspace)
                .select_related("project")
                .first()
            )
            if pm is None:
                continue
            project = pm.project
            done = [str(s.pk) for s in project.statuses.filter(category="done")]
            bug = project.labels.filter(name="bug").first()
            not_done = [{"field": "status", "op": "not", "values": [d]} for d in done]
            defs = [
                (
                    "My open bugs",
                    "user",
                    [
                        {"field": "assignee", "op": "is", "values": ["me"]},
                        *([{"field": "label", "op": "is", "values": [str(bug.pk)]}] if bug else []),
                        *not_done,
                    ],
                ),
                ("Due this week", "calendar", [{"field": "due", "op": "before", "values": ["week"]}, *not_done]),
            ]
            for i, (name, icon, filters) in enumerate(defs):
                view = SavedView.objects.create(
                    workspace=member.workspace,
                    project=project,
                    owner=member.user,
                    name=name,
                    icon=icon,
                    filters=filters,
                )
                ViewPin.objects.create(user=member.user, view=view, position=i)
        self.blocked_views()

    # ── board 39: custom fields, dependencies, time ──

    def load_board39(self, data: dict[str, Any]) -> None:
        ext = board39_from_fixture(data) if "customFields" in data else board39_defaults()
        fields: dict[str, CustomField] = {}
        options: dict[str, CustomFieldOption] = {}
        for f in ext["customFields"]:
            if f["projectId"] not in self.projects:
                continue
            field = CustomField.objects.create(
                project=self.projects[f["projectId"]],
                name=f["name"],
                type=f["type"],
                required=f["required"],
                position=f["position"],
                created_at=self.ts(f.get("createdAt")) or timezone.now(),
            )
            fields[f["id"]] = field
            for o in f.get("options") or []:
                options[o["id"]] = CustomFieldOption.objects.create(
                    field=field, name=o["name"], color=o["color"], position=o["position"]
                )
        for task_id, values in ext["taskValues"].items():
            task = self.tasks.get(task_id)
            for field_id, value in values.items():
                target = fields.get(field_id)
                if task is None or target is None or value in (None, ""):
                    continue
                TaskFieldValue.objects.create(task=task, field=target, **self.value_column(target, value, options))
        for task_id, minutes in ext["timeEstimates"].items():
            if task_id in self.tasks and minutes:
                Task.all_objects.filter(pk=self.tasks[task_id].pk).update(time_estimate_minutes=minutes)
        for d in ext["dependencies"]:
            blocker, blocked = self.tasks.get(d["blockerId"]), self.tasks.get(d["blockedId"])
            if blocker is None or blocked is None:
                continue
            TaskDependency.objects.create(
                blocker=blocker,
                blocked=blocked,
                project=blocked.project,
                created_by=self.users.get(d.get("createdById")),
                created_at=self.ts(d.get("createdAt")) or timezone.now(),
            )
        for e in ext["timeEntries"]:
            task = self.tasks.get(e["taskId"])
            if task is None or e["userId"] not in self.users:
                continue
            TimeEntry.objects.create(
                task=task,
                project=task.project,
                user=self.users[e["userId"]],
                minutes=e["minutes"],
                date=self.day(e["date"]),
                note=e.get("note") or "",
                source=e.get("source") or "manual",
                created_at=self.ts(e.get("createdAt")) or timezone.now(),
            )
        if ext["fill"]:
            self.timesheet_fill(data, skip={e["taskId"] for e in ext["timeEntries"]})

    # ── board 32: timeline & calendar ──

    def load_board32(self) -> None:
        """A port of the mock's `ensureExt32`: PRJ start dates where the task has none and its due date is still
        the seeded one, the four design epic dates where the epic has none, and PRJ-50 blocks PRJ-52."""
        if "p_prj" not in self.projects:
            return
        for number, start, due in PRJ_DATES:
            task = self.tasks.get(f"p_prj-t{number}")
            if task is None or task.start_date is not None or task.due_date != self.day(due):
                continue
            task.start_date = self.day(start)
            Task.all_objects.filter(pk=task.pk).update(start_date=task.start_date)
        for epic_id, (start, due) in EPIC_DATES.items():
            epic = self.epics.get(epic_id)
            if epic is None or epic.start_date is not None or epic.due_date is not None:
                continue
            epic.start_date, epic.due_date = self.day(start), self.day(due)
            epic.save(update_fields=["start_date", "due_date"])
        blocker, blocked = self.tasks.get("p_prj-t50"), self.tasks.get("p_prj-t52")
        if blocker and blocked and not TaskDependency.objects.filter(blocker=blocker, blocked=blocked).exists():
            TaskDependency.objects.create(
                blocker=blocker,
                blocked=blocked,
                project=blocked.project,
                created_by=self.users.get("u_jordan"),
                created_at=timezone.now() - dt.timedelta(hours=2),
            )

    def value_column(self, field: CustomField, value: Any, options: dict[str, CustomFieldOption]) -> dict[str, Any]:
        if field.type == "number":
            return {"number": Decimal(str(value))}
        if field.type == "date":
            return {"date": self.day(value)}
        if field.type == "select":
            return {"option": options[value]}
        if field.type == "user":
            return {"user": self.users[value]}
        return {"text": str(value)}

    def timesheet_fill(self, data: dict[str, Any], skip: set[str]) -> None:
        """Weekday entries (1–4 h in 30-minute steps) for this and last week up to today, for members of PRJ, MOB
        and INF on their open assigned tasks. A port of the mock's `seedTimesheet` (same hash, same choices), in
        real dates like the mock's `rel()`."""
        today = timezone.now().date()
        start = today - dt.timedelta(days=today.weekday() + 7)
        user_index = {u["id"]: i for i, u in enumerate(data["users"])}
        done = {sid for sid, s in self.statuses.items() if s.category == "done"}
        entries = []
        for pi, project_id in enumerate(("p_prj", "p_mob", "p_inf")):
            project = self.projects.get(project_id)
            if project is None:
                continue
            for m in (m for m in data["projectMembers"] if m["projectId"] == project_id):
                ui = user_index.get(m["userId"], -1)
                open_tasks = [
                    self.tasks[t["id"]]
                    for t in data["tasks"]
                    if t["projectId"] == project_id
                    and t["assigneeId"] == m["userId"]
                    and not t.get("deletedAt")
                    and t["statusId"] not in done
                    and t["id"] not in skip
                ]
                if not open_tasks:
                    continue
                for d in range(14):
                    day = start + dt.timedelta(days=d)
                    if day > today or d % 7 >= 5:
                        continue
                    h = mix(ui, d, pi)
                    if h % 10 < 4:
                        continue
                    entries.append(
                        TimeEntry(
                            task=open_tasks[(h >> 8) % len(open_tasks)],
                            project=project,
                            user=self.users[m["userId"]],
                            minutes=60 + ((h >> 4) % 7) * 30,
                            date=day,
                            note="" if (h >> 12) % 3 == 0 else FILL_NOTES[(h >> 14) % 5],
                            source="timer" if (h >> 16) % 4 == 0 else "manual",
                            created_at=dt.datetime.combine(day, dt.time(17, 10 + h % 40), tzinfo=dt.UTC),
                        )
                    )
        TimeEntry.objects.bulk_create(entries)

    def blocked_views(self) -> None:
        """A personal pinned "Blocked" view for every PRJ member (after their existing pins)."""
        project = self.projects.get("p_prj")
        if project is None:
            return
        for member in ProjectMember.objects.filter(project=project).select_related("user"):
            if SavedView.objects.filter(
                workspace=project.workspace, owner=member.user, name__iexact="Blocked"
            ).exists():
                continue
            view = SavedView.objects.create(
                workspace=project.workspace,
                project=project,
                owner=member.user,
                name="Blocked",
                icon="flag",
                layout="board",
                filters=[{"field": "blocked", "op": "is", "values": ["true"]}],
            )
            last = ViewPin.objects.filter(user=member.user).aggregate(m=Max("position"))["m"]
            ViewPin.objects.create(user=member.user, view=view, position=0 if last is None else last + 1)

    def report(self, data: dict[str, Any]) -> None:
        out = self.stdout
        out.write(self.style.SUCCESS("Demo data created."))
        counts = {k: len(data[k]) for k in ("workspaces", "projects", "tasks", "sprints")}
        out.write("  " + ", ".join(f"{v} {k}" for k, v in counts.items()))
        out.write(f"  Password for every account: {DEMO_PASSWORD}")
        for email in ("alex@team.dev", "jordan@team.dev", "sam@team.dev", "taylor@team.dev", "casey@team.dev"):
            out.write(f"    {email}")
        for email, link in getattr(self, "invite_links", []):
            out.write(f"  Pending invite for {email}: {link}")


# ───────────────────────── board 32 seed data (docs/v2/32-timeline-calendar.md §6.9) ─────────────────────────

# (PRJ task number, startDate, dueDate as seeded in v1), design dates relative to ANCHOR.
PRJ_DATES = [
    (31, "2026-09-24", "2026-09-30"), (33, "2026-10-02", "2026-10-14"), (34, "2026-10-06", "2026-10-10"),
    (38, "2026-10-09", "2026-10-16"), (40, "2026-09-22", "2026-10-02"), (42, "2026-10-01", "2026-10-21"),
    (44, "2026-10-05", "2026-10-08"), (48, "2026-10-05", "2026-10-09"), (49, "2026-09-03", "2026-09-10"),
    (50, "2026-09-29", "2026-10-06"), (52, "2026-10-14", "2026-10-20"), (53, "2026-09-25", "2026-09-29"),
    (54, "2026-10-12", "2026-10-14"), (57, "2026-10-05", "2026-10-15"), (58, "2026-10-12", "2026-10-17"),
    (60, "2026-09-01", "2026-09-08"), (61, "2026-09-24", "2026-10-01"), (62, "2026-09-21", "2026-09-28"),
    (65, "2026-10-01", "2026-10-05"), (66, "2026-10-13", "2026-10-18"), (67, "2026-10-20", "2026-10-26"),
    (71, "2026-10-14", "2026-10-19"),
]  # fmt: skip
EPIC_DATES = {
    "ep_auth": ("2026-09-14", "2026-10-23"),
    "ep_board": ("2026-09-21", "2026-11-06"),
    "ep_sprint": ("2026-09-01", "2026-10-30"),
    "ep_bill": ("2026-09-01", "2026-11-20"),
}


# ───────────────────────── board 39 seed data ─────────────────────────

FILL_NOTES = ["Implementation", "Review fixes", "Pairing", "Investigation", "Tests"]


def mix(*numbers: int) -> int:
    """The mock's small 32-bit integer hash (frontend/src/lib/mock/handlers/extensions.ts `mix`)."""
    h = 2166136261
    for x in numbers:
        h ^= (x + 0x9E3779B9) & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
        h ^= h >> 13
    return h & 0xFFFFFFFF


def board39_from_fixture(data: dict[str, Any]) -> dict[str, Any]:
    """The mock's own collections (fixture regenerated from a frontend seed that has board 39)."""
    tasks = data["tasks"]
    return {
        "customFields": data.get("customFields") or [],
        "taskValues": {t["id"]: t["customFields"] for t in tasks if t.get("customFields")},
        "timeEstimates": {t["id"]: t["timeEstimateMinutes"] for t in tasks if t.get("timeEstimateMinutes")},
        "dependencies": data.get("dependencies") or [],
        "timeEntries": data.get("timeEntries") or [],
        "fill": False,
    }


def board39_defaults() -> dict[str, Any]:
    """PRJ seed data from the board 39 contract (§6.8), in the mock's id and date format."""
    cf = "p_prj-cf-"
    created = "2026-10-01T09:00:00Z"  # six days before the anchor
    browser = [("chrome", "Chrome", "var(--low)"), ("safari", "Safari", "var(--accent-t)"),
               ("firefox", "Firefox", "var(--orange)"), ("edge", "Edge", "var(--info)")]  # fmt: skip
    fields = [
        {"id": f"{cf}browser", "name": "Browser", "type": "select", "required": False,
         "options": [{"id": f"{cf}browser-{k}", "name": n, "color": c, "position": i}
                     for i, (k, n, c) in enumerate(browser)]},
        {"id": f"{cf}found", "name": "Found in", "type": "text", "required": True},
        {"id": f"{cf}accounts", "name": "Accounts affected", "type": "number", "required": False},
        {"id": f"{cf}qasignoff", "name": "QA sign-off", "type": "date", "required": False},
        {"id": f"{cf}qaowner", "name": "QA owner", "type": "user", "required": False},
    ]  # fmt: skip
    for i, f in enumerate(fields):
        f.update({"projectId": "p_prj", "position": i, "createdAt": created})
        f.setdefault("options", [])

    def row(browser_key, found, accounts, signoff, owner):
        values = {
            f"{cf}browser": f"{cf}browser-{browser_key}" if browser_key else None,
            f"{cf}found": found,
            f"{cf}accounts": accounts,
            f"{cf}qasignoff": signoff,
            f"{cf}qaowner": owner,
        }
        return {k: v for k, v in values.items() if v is not None}

    values = {
        "p_prj-t42": row("safari", "v2.3.1", 1240, None, "u_riley"),
        "p_prj-t48": row("chrome", "v2.3.0", 310, None, "u_sam"),
        "p_prj-t53": row("firefox", "v2.2.4", 18, "2026-09-28", "u_morgan"),
        "p_prj-t51": row("safari", "v2.3.1", None, None, None),
        "p_prj-t33": row(None, "v2.3.0", None, None, "u_jordan"),
    }
    links = [("p_prj-t48", "p_prj-t42"), ("p_prj-t40", "p_prj-t42"), ("p_prj-t42", "p_prj-t47"),
             ("p_prj-t42", "p_prj-t68"), ("p_prj-t57", "p_prj-t58")]  # fmt: skip
    dependencies = [
        {"id": f"p_prj-dep-{i}", "projectId": "p_prj", "blockerId": a, "blockedId": b,
         "createdById": "u_jordan", "createdAt": f"2026-10-07T0{4 + i}:00:00Z"}
        for i, (a, b) in enumerate(links)
    ]  # fmt: skip
    entries = [
        ("u_alex", 90, "2026-10-05", "Repro + profiling", "manual", "2026-10-05T16:40:00Z"),
        ("u_jordan", 45, "2026-10-06", "Safari check", "manual", "2026-10-06T11:40:00Z"),
        ("u_alex", 120, "2026-10-07", "ResizeObserver fix", "timer", "2026-10-07T09:40:00Z"),
    ]
    time_entries = [
        {"id": f"p_prj-te-{i}", "taskId": "p_prj-t42", "projectId": "p_prj", "userId": u, "minutes": m,
         "date": d, "note": n, "source": src, "createdAt": at}
        for i, (u, m, d, n, src, at) in enumerate(entries)
    ]  # fmt: skip
    return {
        "customFields": fields,
        "taskValues": values,
        "timeEstimates": {"p_prj-t42": 360},
        "dependencies": dependencies,
        "timeEntries": time_entries,
        "fill": True,
    }
