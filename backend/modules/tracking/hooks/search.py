"""Tracking's search provider: tasks and projects (workspace palette), tasks and task comments (global full-text).

PostgreSQL full-text search over GIN-indexed search vectors, always limited to projects the user is a member of.
"""

from __future__ import annotations

import re
from typing import Any

from django.contrib.postgres.search import SearchRank
from django.db.models import F, Q, QuerySet, Value

from core.collab.models import Comment
from core.common.utils import iso
from core.search.services import SearchProvider, register_search_provider, ts_query

KEY_RE = re.compile(r"^[A-Za-z]{2,5}-\d+$")


def member_projects(user: Any, workspace: Any = None) -> QuerySet:
    from modules.tracking.projects.models import ProjectMember

    qs = ProjectMember.objects.filter(
        user=user, project__deleted_at__isnull=True, project__workspace__deleted_at__isnull=True
    )
    if workspace is not None:
        qs = qs.filter(project__workspace=workspace)
    return qs.values("project_id")


def search_tasks(user: Any, q: str, *, workspace: Any = None, limit: int = 20) -> list[Any]:
    from modules.tracking.tasks import selectors as task_selectors
    from modules.tracking.tasks.models import Task

    base = Task.objects.filter(project_id__in=member_projects(user, workspace))
    q = q.strip()
    if not q:
        return list(task_selectors.annotated(base.select_related("status", "project")).order_by("-updated_at")[:limit])
    query = ts_query(q)
    cond = Q(key__iexact=q) | Q(title__icontains=q)
    if query is not None:
        cond |= Q(search_vector=query)
    qs = base.filter(cond)
    qs = qs.annotate(rank=SearchRank(F("search_vector"), query)) if query is not None else qs.annotate(rank=Value(0.0))
    ordered = qs.order_by("-rank", "-updated_at").select_related("status", "project")
    exact = list(base.filter(key__iexact=q).select_related("status", "project")) if KEY_RE.match(q) else []
    rows = exact + [t for t in task_selectors.annotated(ordered)[:limit] if t not in exact]
    return rows[:limit]


def search_comments(user: Any, q: str, *, limit: int = 20) -> list[tuple[Comment, Any]]:
    """Comments on tasks the user can see, each with its task."""
    from modules.tracking.tasks.models import Task

    query = ts_query(q)
    if query is None:
        return []
    visible = Task.objects.filter(project_id__in=member_projects(user)).values("id")
    qs = Comment.objects.filter(target_type="tracking.task", target_id__in=visible).filter(
        Q(search_vector=query) | Q(body_text__icontains=q.strip())
    )
    comments = list(qs.annotate(rank=SearchRank(F("search_vector"), query)).order_by("-rank", "-created_at")[:limit])
    tasks = Task.objects.select_related("project", "project__workspace").in_bulk([c.target_id for c in comments])
    return [(c, tasks[c.target_id]) for c in comments if c.target_id in tasks]


def _link(task: Any) -> str:
    from .targets import task_url

    return task_url(task)


def task_result(task: Any) -> dict[str, Any]:
    from modules.tracking.tasks.serializers import task_data

    return {
        "type": "task",
        "task": task_data(task),
        "projectKey": task.project.key,
        "projectName": task.project.name,
        "status": {"name": task.status.name, "glyph": task.status.glyph},
        "targetType": "tracking.task",
        "targetId": str(task.pk),
        "title": task.title,
        "link": _link(task),
    }


def comment_result(comment: Comment, task: Any) -> dict[str, Any]:
    return {
        "type": "comment",
        "comment": {
            "id": str(comment.pk),
            "targetType": comment.target_type,
            "targetId": str(comment.target_id),
            "authorId": str(comment.author_id) if comment.author_id else None,
            "excerpt": comment.body_text[:200],
            "createdAt": iso(comment.created_at),
        },
        "taskKey": task.key,
        "taskTitle": task.title,
        "projectKey": task.project.key,
        "targetType": "core.comment",
        "targetId": str(comment.pk),
        "title": task.title,
        "link": _link(task),
    }


class TrackingSearch(SearchProvider):
    types = ("task", "project")
    global_types = ("task", "comment")

    def search(self, user: Any, workspace: Any, query: str, limit: int, types: set[str]) -> list[dict[str, Any]]:
        from django.conf import settings

        from modules.tracking.projects.models import Project
        from modules.tracking.projects.selectors import with_counts
        from modules.tracking.projects.serializers import ProjectSerializer, project_context

        out: list[dict[str, Any]] = []
        if "task" in types:
            out.extend(task_result(t) for t in search_tasks(user, query, workspace=workspace, limit=limit))
        if "project" in types:
            projects = Project.objects.filter(pk__in=member_projects(user, workspace))
            if query:
                projects = projects.filter(Q(name__icontains=query) | Q(key__icontains=query))
            rows = list(with_counts(projects).order_by("name")[:limit])
            ctx = project_context(user, rows)
            out.extend(
                {
                    "type": "project",
                    "project": ProjectSerializer(p, context=ctx).data,
                    "targetType": "tracking.project",
                    "targetId": str(p.pk),
                    "title": p.name,
                    "link": f"{settings.FRONTEND_URL}/{workspace.slug}/projects/{p.key}/board",
                }
                for p in rows
            )
        return out

    def search_all(self, user: Any, query: str, limit: int, types: set[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if "task" in types:
            out.extend(task_result(t) for t in search_tasks(user, query, limit=limit))
        if "comment" in types:
            out.extend(comment_result(c, t) for c, t in search_comments(user, query, limit=limit))
        return out


def register() -> None:
    register_search_provider("tracking", TrackingSearch())
