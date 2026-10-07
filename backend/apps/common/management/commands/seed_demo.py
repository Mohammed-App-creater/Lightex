"""Demo data equivalent to the web client's mock seed (development only).

Loads apps/common/fixtures/demo_seed.json, which is exported from frontend/src/lib/mock/seed.ts (see
scripts/frontend-seed/). IDs become UUIDs and every date is shifted so the data looks current.
Status history is synthesised from each task's started/completed timestamps so reports have data.

    python manage.py seed_demo            # refuses if the demo workspace already exists
    python manage.py seed_demo --flush    # deletes the demo workspaces and users first

Every demo account uses DEMO_PASSWORD. The command refuses to run when DEBUG is off.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
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
from apps.projects.models import Label, Project, ProjectKeyAlias, ProjectMember, SavedView, Status, ViewPin
from apps.tasks.models import Task, TaskLabel, TaskObjective, TaskStatusHistory
from apps.tasks.services import refresh_search_vector
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
                joined_at=self.ts(m["joinedAt"]),
                last_active_at=self.ts(m["lastActiveAt"]),
            )
        self.load_projects(data)
        self.load_planning(data)
        self.load_tasks(data)
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
                added_at=self.ts(m["addedAt"]),
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
                created_at=self.ts(o["createdAt"]),
            )
        for m in data["milestones"]:
            self.milestones[m["id"]] = Milestone.objects.create(
                project=self.projects[m["projectId"]],
                name=m["name"],
                description=m["description"],
                owner=self.users.get(m["ownerId"]),
                start_date=self.date(m["startDate"]),
                due_date=self.date(m["dueDate"]),
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
            )
        for s in data["sprints"]:
            start, end = self.date(s["startDate"]), self.date(s["endDate"])
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
        rows = []
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
                created_at=self.ts(n["createdAt"]),
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
                created_at=self.ts(a["createdAt"]),
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
