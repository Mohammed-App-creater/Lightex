"""PostgreSQL full-text search over tasks and comments (GIN-indexed search vectors), always limited
to projects the user is a member of."""

from __future__ import annotations

import re
from typing import Any

from django.contrib.postgres.search import SearchQuery, SearchRank
from django.db.models import F, Q, QuerySet

from apps.accounts.serializers import UserSerializer
from apps.collaboration.models import Comment
from apps.common.utils import iso
from apps.projects.models import Project, ProjectMember
from apps.tasks import selectors as task_selectors
from apps.tasks.models import Task
from apps.tasks.serializers import task_data
from apps.workspaces.models import WorkspaceMember

KEY_RE = re.compile(r"^[A-Za-z]{2,5}-\d+$")


def ts_query(q: str) -> SearchQuery | None:
    """Prefix-matching query for type-ahead ("boa" finds "board") OR an English websearch query."""
    words = re.findall(r"[A-Za-z0-9]+", q.lower())[:8]
    if not words:
        return None
    prefix = SearchQuery(" & ".join(f"{w}:*" for w in words), search_type="raw", config="simple")
    return prefix | SearchQuery(q, search_type="websearch", config="english")


def member_projects(user: Any, workspace: Any = None) -> QuerySet:
    qs = ProjectMember.objects.filter(
        user=user, project__deleted_at__isnull=True, project__workspace__deleted_at__isnull=True
    )
    if workspace is not None:
        qs = qs.filter(project__workspace=workspace)
    return qs.values("project_id")


def search_tasks(user: Any, q: str, *, workspace: Any = None, limit: int = 20) -> list[Task]:
    base = Task.objects.filter(project_id__in=member_projects(user, workspace))
    q = q.strip()
    if not q:
        return list(task_selectors.annotated(base.select_related("status", "project")).order_by("-updated_at")[:limit])
    query = ts_query(q)
    cond = Q(key__iexact=q) | Q(title__icontains=q)
    if query is not None:
        cond |= Q(search_vector=query)
    qs = base.filter(cond)
    if query is not None:
        qs = qs.annotate(rank=SearchRank(F("search_vector"), query))
    else:
        from django.db.models import Value

        qs = qs.annotate(rank=Value(0.0))
    ordered = qs.order_by("-rank", "-updated_at").select_related("status", "project")
    exact = list(base.filter(key__iexact=q).select_related("status", "project")) if KEY_RE.match(q) else []
    rows = exact + [t for t in task_selectors.annotated(ordered)[:limit] if t not in exact]
    return rows[:limit]


def search_comments(user: Any, q: str, *, limit: int = 20) -> list[Comment]:
    query = ts_query(q)
    if query is None:
        return []
    qs = Comment.objects.filter(task__project_id__in=member_projects(user), task__deleted_at__isnull=True).filter(
        Q(search_vector=query) | Q(body_text__icontains=q.strip())
    )
    return list(
        qs.annotate(rank=SearchRank(F("search_vector"), query))
        .order_by("-rank", "-created_at")
        .select_related("task", "task__project")[:limit]
    )


def task_result(task: Task) -> dict[str, Any]:
    return {
        "type": "task",
        "task": task_data(task),
        "projectKey": task.project.key,
        "projectName": task.project.name,
        "status": {"name": task.status.name, "glyph": task.status.glyph},
    }


def comment_result(comment: Comment) -> dict[str, Any]:
    return {
        "type": "comment",
        "comment": {
            "id": str(comment.pk),
            "taskId": str(comment.task_id),
            "authorId": str(comment.author_id) if comment.author_id else None,
            "excerpt": comment.body_text[:200],
            "createdAt": iso(comment.created_at),
        },
        "taskKey": comment.task.key,
        "taskTitle": comment.task.title,
        "projectKey": comment.task.project.key,
    }


def workspace_search(user: Any, workspace: Any, q: str, types: list[str], limit: int) -> list[dict[str, Any]]:
    """The command palette's search: tasks, projects and people in one workspace."""
    from apps.projects.selectors import with_counts
    from apps.projects.serializers import ProjectSerializer, project_context

    want = set(types) or {"task", "project", "user"}
    out: list[dict[str, Any]] = []
    q = q.strip()
    if "task" in want:
        out.extend(task_result(t) for t in search_tasks(user, q, workspace=workspace, limit=limit))
    if "project" in want:
        projects = Project.objects.filter(pk__in=member_projects(user, workspace))
        if q:
            projects = projects.filter(Q(name__icontains=q) | Q(key__icontains=q))
        rows = list(with_counts(projects).order_by("name")[:limit])
        ctx = project_context(user, rows)
        out.extend({"type": "project", "project": ProjectSerializer(p, context=ctx).data} for p in rows)
    if "user" in want:
        members = WorkspaceMember.objects.filter(workspace=workspace, status="active").select_related("user", "role")
        if q:
            members = members.filter(Q(user__name__icontains=q) | Q(user__email__icontains=q))
        out.extend(
            {"type": "user", "user": UserSerializer(m.user).data, "roleName": m.role.name}
            for m in members.order_by("user__name")[:limit]
        )
    return out
