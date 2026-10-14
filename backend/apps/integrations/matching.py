"""Task-key matching, branch names and check aggregation (docs/v2/37-integrations-github-gitlab.md §6, §9.4).

Identical to the client's `features/integrations/lib/` and driven by the same shared vectors (`tests/dev-vectors.json`).
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import Any

from django.db.models import Q

KEY_RE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{2,5})-([1-9][0-9]{0,6})(?![A-Za-z0-9])")
MAX_KEYS = 10
STOP = {"on", "the", "a", "an", "to", "for", "of", "in", "and", "with"}
BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
MAX_BRANCH = 80


def key_pairs(texts: Iterable[str], limit: int = MAX_KEYS) -> list[tuple[str, int]]:
    """Distinct (PREFIX, number) pairs in first-seen order, at most `limit` per object (§6.2 step 1)."""
    out: list[tuple[str, int]] = []
    for text in texts:
        for m in KEY_RE.finditer(text or ""):
            pair = (m.group(1).upper(), int(m.group(2)))
            if pair not in out:
                out.append(pair)
                if len(out) >= limit:
                    return out
    return out


def find_keys(texts: Iterable[str], prefixes: Iterable[str]) -> list[str]:
    """Keys whose prefix is one of `prefixes` (the vectors' function)."""
    allowed = {p.upper() for p in prefixes}
    return [f"{p}-{n}" for p, n in key_pairs(texts) if p in allowed]


def resolve_keys(workspace_id: Any, texts: Iterable[str], repository: Any = None) -> list[Any]:
    """Live tasks of the workspace named by keys in `texts` (§6.2): prefixes through `ProjectKeyAlias` (retired keys
    too), lookup by alias project + number, repository scope applied. Archived projects' tasks are included."""
    from apps.projects.models import ProjectKeyAlias
    from apps.tasks.models import Task

    pairs = key_pairs(texts)
    if not pairs:
        return []
    aliases = dict(
        ProjectKeyAlias.objects.filter(
            workspace_id=workspace_id, key__in={p for p, _ in pairs}, project__deleted_at__isnull=True
        ).values_list("key", "project_id")
    )
    wanted = [(aliases[p], n) for p, n in pairs if p in aliases]
    if not wanted:
        return []
    q = Q()
    for project_id, number in wanted:
        q |= Q(project_id=project_id, number=number)
    tasks = {
        (t.project_id, t.number): t
        for t in Task.objects.filter(q, project__deleted_at__isnull=True).select_related("project")
    }
    ordered = [tasks[w] for w in dict.fromkeys(wanted) if w in tasks]
    if repository is not None and not repository.all_projects:
        from .models import RepositoryProject

        scope = set(RepositoryProject.objects.filter(repository=repository).values_list("project_id", flat=True))
        ordered = [t for t in ordered if t.project_id in scope]
    return ordered


def suggest_branch(key: str, title: str, prefix: str = "") -> str:
    """§9.4: `prj-42-fix-flaky-board-reflow`."""
    text = "".join(c for c in unicodedata.normalize("NFKD", title or "") if not unicodedata.combining(c)).lower()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    words = [w for w in re.split(r"\s+", text) if w and w not in STOP][:4]
    name = "-".join([key.lower(), *words])
    name = re.sub(r"-{2,}", "-", name)
    name = re.sub(r"-+$", "", name)
    return re.sub(r"[-/.]+$", "", (prefix + name)[:MAX_BRANCH])


def validate_branch(name: str) -> str | None:
    """§6.3 branch name rules: the 422 message, or None when valid."""
    if not isinstance(name, str) or not name:
        return "Use letters, numbers, - _ . / only."
    if len(name) > MAX_BRANCH:
        return "Up to 80 characters."
    if ".." in name:
        return "Branch names can't contain '..'."
    if not BRANCH_RE.match(name) or "//" in name or "@{" in name:
        return "Use letters, numbers, - _ . / only."
    if name[0] in "-/." or name[-1] in "/." or name.endswith(".lock"):
        return "Use letters, numbers, - _ . / only."
    return None


def aggregate_checks(states: Iterable[str]) -> str | None:
    """failing > running > passing; no checks → None."""
    seen = set(states)
    if not seen:
        return None
    for state in ("failing", "running"):
        if state in seen:
            return state
    return "passing"


def hash_hue(login: str) -> int:
    return (sum(ord(c) for c in login) * 37) % 360
