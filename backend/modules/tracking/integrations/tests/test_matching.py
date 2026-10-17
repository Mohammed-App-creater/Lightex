"""§6 task-key matching, §9.4 branch names and check aggregation, driven by the shared vectors (§12.3)."""

import json
from pathlib import Path

import pytest

from core.common.testing import UserFactory, client_for, make_project, make_workspace
from modules.tracking.integrations import matching
from modules.tracking.integrations.models import RepositoryProject
from modules.tracking.tasks.services import create_task, delete_task

from .conftest import track

VECTORS = json.loads((Path(__file__).parent / "dev-vectors.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", VECTORS["keys"], ids=lambda c: " | ".join(c["texts"])[:40])
def test_key_vectors(case):
    assert matching.find_keys(case["texts"], case["prefixes"]) == case["expected"]


@pytest.mark.parametrize("case", VECTORS["suggestBranch"], ids=lambda c: c["expected"])
def test_suggest_branch_vectors(case):
    assert matching.suggest_branch(case["key"], case["title"], case["prefix"]) == case["expected"]


def test_validate_branch_vectors():
    for name in VECTORS["validateBranch"]["invalid"]:
        assert matching.validate_branch(name), name
    for name in VECTORS["validateBranch"]["valid"]:
        assert matching.validate_branch(name) is None, name
    assert matching.validate_branch("a" * 81) == "Up to 80 characters."
    assert matching.validate_branch("a..b") == "Branch names can't contain '..'."


@pytest.mark.parametrize("case", VECTORS["checks"], ids=lambda c: ",".join(c["states"]) or "none")
def test_check_vectors(case):
    assert matching.aggregate_checks(case["states"]) == case["expected"]


@pytest.mark.parametrize("case", VECTORS["hashHue"], ids=lambda c: c["login"])
def test_hash_hue_vectors(case):
    assert matching.hash_hue(case["login"]) == case["expected"]


@pytest.mark.django_db
def test_resolution_aliases_isolation_deletion_and_scope(ws, owner, github):
    prj = make_project(ws, owner, key="PRJ")
    tasks = [create_task(owner, prj, {"title": f"T{i}"}) for i in range(3)]
    mob = make_project(ws, owner, key="MOB")
    m1 = create_task(owner, mob, {"title": "Mobile"})
    # Rename PRJ → XYZ: the retired prefix still resolves, also for numbers created after the rename.
    assert (
        client_for(owner).patch(f"/api/v1/tracking/projects/{prj.id}", {"key": "XYZ"}, format="json").status_code == 200
    )
    later = create_task(owner, prj, {"title": "After rename"})
    found = matching.resolve_keys(ws.pk, [f"PRJ-1 and prj-{later.number} xyz-2 MOB-1"])
    assert [t.pk for t in found] == [tasks[0].pk, later.pk, tasks[1].pk, m1.pk]
    # Another workspace's project with the same key is never matched.
    other_ws = make_workspace(UserFactory(), slug="elsewhere")
    other = make_project(other_ws, other_ws.members.first().user, key="MOB")
    create_task(other_ws.members.first().user, other, {"title": "x"})
    assert [t.project_id for t in matching.resolve_keys(ws.pk, ["MOB-1"])] == [mob.pk]
    # Deleted tasks are skipped; repository scope drops other projects silently.
    delete_task(owner, tasks[2])
    assert matching.resolve_keys(ws.pk, ["XYZ-3"]) == []
    repo = track(github, all_projects=False)
    RepositoryProject.objects.create(repository=repo, project=mob)
    assert [t.pk for t in matching.resolve_keys(ws.pk, ["XYZ-1 MOB-1"], repo)] == [m1.pk]


def test_key_cap_is_ten_per_object():
    text = " ".join(f"PRJ-{i}" for i in range(1, 13))
    assert len(matching.key_pairs([text])) == 10
