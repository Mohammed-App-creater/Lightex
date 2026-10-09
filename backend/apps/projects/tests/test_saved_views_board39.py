"""Board 39: `blocked` and `cf.<fieldId>` rules in saved views (clean_rules / apply_rules / counts).

The vectors below are the shared backend/frontend semantics of docs/v2/39-fields-dependencies-time.md §4.7."""

import datetime as dt

import pytest

from apps.common.testing import add_project_member, client_for, make_project
from apps.projects.custom_fields import create_field
from apps.projects.saved_views import apply_rules, clean_rules
from apps.tasks.models import Task, TaskDependency, TaskFieldValue
from apps.tasks.services import create_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def world(owner, project):
    """Four tasks with a spread of values; returns (fields, tasks)."""
    mk = lambda name, kind, **kw: create_field(owner, project, {"name": name, "type": kind, **kw})  # noqa: E731
    fields = {
        "text": mk("Found in", "text"),
        "number": mk("Accounts", "number"),
        "select": mk(
            "Browser",
            "select",
            options=[{"name": "Chrome", "color": "var(--low)"}, {"name": "Safari", "color": "var(--low)"}],
        ),
        "user": mk("QA owner", "user"),
        "date": mk("QA sign-off", "date"),
    }
    t = [create_task(owner, project, {"title": f"T{i}"}) for i in range(4)]
    chrome = fields["select"].options.get(name="Chrome")
    safari = fields["select"].options.get(name="Safari")
    today = dt.date.today()
    rows = [
        (t[0], "text", {"text": "v2.3.1"}),
        (t[0], "number", {"number": 1240}),
        (t[0], "select", {"option": safari}),
        (t[0], "user", {"user": owner}),
        (t[0], "date", {"date": today - dt.timedelta(days=3)}),
        (t[1], "number", {"number": 12.5}),
        (t[1], "select", {"option": chrome}),
        (t[1], "date", {"date": today + dt.timedelta(days=3)}),
    ]
    for task, key, value in rows:
        TaskFieldValue.objects.create(task=task, field=fields[key], **value)
    TaskDependency.objects.create(blocker=t[3], blocked=t[2], project=project)
    return fields, t


def matching(project, owner, rules):
    qs = apply_rules(Task.objects.filter(project=project), rules, owner, project)
    return sorted(int(k.split("-")[1]) - 1 for k in qs.values_list("key", flat=True))


def cf(field):
    return f"cf.{field.id}"


def test_clean_rules_keeps_valid_board39_rows(project, world):
    fields, _ = world
    raw = [
        {"field": "blocked", "op": "is", "values": ["true", "false"]},
        {"field": "blocked", "op": "is", "values": ["maybe"]},  # dropped
        {"field": "blocked", "op": "not", "values": ["true"]},  # dropped
        {"field": cf(fields["text"]), "op": "set", "values": ["x"]},
        {"field": cf(fields["text"]), "op": "is", "values": ["x"]},  # dropped: not a text op
        {"field": cf(fields["number"]), "op": "gt", "values": ["12.5", "3"]},
        {"field": cf(fields["number"]), "op": "lt", "values": ["abc"]},  # dropped
        {"field": cf(fields["select"]), "op": "any", "values": ["a", "b"]},
        {"field": cf(fields["date"]), "op": "before", "values": ["week"]},
        {"field": "cf.00000000-0000-0000-0000-000000000000", "op": "set", "values": []},  # unknown field
    ]
    assert clean_rules(raw, project) == [
        {"field": "blocked", "op": "is", "values": ["true"]},
        {"field": cf(fields["text"]), "op": "set", "values": []},
        {"field": cf(fields["number"]), "op": "gt", "values": ["12.5"]},
        {"field": cf(fields["select"]), "op": "any", "values": ["a", "b"]},
        {"field": cf(fields["date"]), "op": "before", "values": ["week"]},
    ]
    # Without a project, cf rules can't be checked and are dropped.
    assert clean_rules([{"field": cf(fields["text"]), "op": "set", "values": []}]) == []


def test_apply_rules_vectors(owner, project, world):
    fields, _ = world
    chrome = str(fields["select"].options.get(name="Chrome").id)
    safari = str(fields["select"].options.get(name="Safari").id)
    vectors = [
        ([{"field": "blocked", "op": "is", "values": ["true"]}], [2]),
        ([{"field": "blocked", "op": "is", "values": ["false"]}], [0, 1, 3]),
        ([{"field": cf(fields["text"]), "op": "set", "values": []}], [0]),
        ([{"field": cf(fields["text"]), "op": "empty", "values": []}], [1, 2, 3]),
        ([{"field": cf(fields["number"]), "op": "gt", "values": ["12.5"]}], [0]),
        ([{"field": cf(fields["number"]), "op": "lt", "values": ["1240"]}], [1]),
        ([{"field": cf(fields["number"]), "op": "set", "values": []}], [0, 1]),
        ([{"field": cf(fields["select"]), "op": "is", "values": [safari]}], [0]),
        ([{"field": cf(fields["select"]), "op": "any", "values": [safari, chrome]}], [0, 1]),
        ([{"field": cf(fields["select"]), "op": "not", "values": [safari]}], [1, 2, 3]),  # empty matches `not`
        ([{"field": cf(fields["select"]), "op": "empty", "values": []}], [2, 3]),
        ([{"field": cf(fields["user"]), "op": "is", "values": ["me"]}], [0]),
        ([{"field": cf(fields["user"]), "op": "not", "values": [str(owner.id)]}], [1, 2, 3]),
        ([{"field": cf(fields["user"]), "op": "empty", "values": []}], [1, 2, 3]),
        ([{"field": cf(fields["date"]), "op": "before", "values": ["today"]}], [0]),
        ([{"field": cf(fields["date"]), "op": "after", "values": ["today"]}], [1]),
        ([{"field": cf(fields["date"]), "op": "before", "values": ["week"]}], [0, 1]),
        ([{"field": cf(fields["date"]), "op": "after", "values": ["sprint"]}], []),  # no active sprint
        ([{"field": cf(fields["date"]), "op": "empty", "values": []}], [2, 3]),
        (
            [
                {"field": "blocked", "op": "is", "values": ["false"]},
                {"field": cf(fields["number"]), "op": "set", "values": []},
            ],
            [0, 1],
        ),
    ]
    for rules, expected in vectors:
        assert matching(project, owner, rules) == expected, rules


def test_rules_for_deleted_fields_are_ignored_and_counts(owner, project, world):
    fields, _ = world
    client = client_for(owner)
    res = client.post(
        "/api/v1/workspaces/platform/views",
        {
            "projectId": str(project.id),
            "name": "Has accounts",
            "filters": [
                {"field": cf(fields["number"]), "op": "set", "values": []},
                {"field": cf(fields["text"]), "op": "set", "values": []},
            ],
        },
        format="json",
    )
    assert res.status_code == 201, res.content
    assert res.json()["count"] == 1
    view_id = res.json()["id"]
    client.delete(f"/api/v1/custom-fields/{fields['text'].id}")
    [view] = [v for v in client.get("/api/v1/workspaces/platform/views").json() if v["id"] == view_id]
    assert view["count"] == 2  # the deleted field's rule now matches everything
    assert len(view["filters"]) == 2  # left as saved
    res = client.patch(
        f"/api/v1/views/{view_id}",
        {"filters": [{"field": "blocked", "op": "is", "values": ["true"]}]},
        format="json",
    )
    assert res.json()["count"] == 1


def test_blocked_view_counts_follow_status(owner, project, world):
    _, t = world
    member = add_project_member(project, key="project_member")
    res = client_for(member).post(
        "/api/v1/workspaces/platform/views",
        {"projectId": str(project.id), "name": "Blocked", "icon": "flag", "pinned": True,
         "filters": [{"field": "blocked", "op": "is", "values": ["true"]}]},
        format="json",
    )  # fmt: skip
    assert res.json()["count"] == 1
    done = project.statuses.get(glyph="done")
    Task.objects.filter(pk=t[3].pk).update(status=done)
    [view] = client_for(member).get("/api/v1/workspaces/platform/views").json()
    assert view["count"] == 0
