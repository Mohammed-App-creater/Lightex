"""`@all` in comments: everyone who can see the target (except the author) is mentioned and notified once."""

import pytest

from core.common.richtext import doc_text, sanitize_doc
from core.common.testing import add_member, client_for
from core.notifications.models import Notification
from modules.tracking.tasks.services import create_task
from modules.tracking.testing import add_project_member, make_project

pytestmark = pytest.mark.django_db


def doc(*mentions):
    nodes = [{"type": "text", "text": "Hey "}]
    nodes += [{"type": "mention", "attrs": {"id": i, "label": label}} for i, label in mentions]
    return {"type": "doc", "content": [{"type": "paragraph", "content": nodes}]}


ALL = ("all", "all")


def mentioned(user):
    return Notification.objects.unscoped().filter(recipient=user, kind="mention").count()


@pytest.fixture
def setup(ws, owner):
    project = make_project(ws, owner, key="ALL", template="scrum")
    task = create_task(owner, project, {"title": "Everyone"})
    alice = add_project_member(project)
    bob = add_project_member(project)
    outside = add_member(ws)  # workspace member, not in the project
    return project, task, alice, bob, outside


def url(task):
    return f"/api/v1/targets/tracking.task/{task.id}/comments"


def test_richtext_keeps_the_all_mention():
    clean = sanitize_doc(doc(ALL))
    assert clean["content"][0]["content"][1]["attrs"] == {"id": "all", "label": "all"}
    assert doc_text(clean) == "Hey @all"


def test_all_notifies_project_members_except_author(owner, setup):
    _, task, alice, bob, outside = setup
    res = client_for(owner).post(url(task), {"body": doc(ALL, (str(alice.id), "Alice"))}, format="json")
    assert res.status_code == 201, res.json()
    body = res.json()
    assert body["mentionsAll"] is True
    assert set(body["mentions"]) == {str(alice.id), str(bob.id)}
    assert (mentioned(alice), mentioned(bob), mentioned(outside), mentioned(owner)) == (1, 1, 0, 0)
    # "Mentioned me" finds it.
    assert client_for(bob).get("/api/v1/notifications?tab=mentions").json()["counts"]["mentions"] == 1


def test_editing_in_all_notifies_only_new_people(owner, setup):
    project, task, alice, bob, _ = setup
    client = client_for(owner)
    res = client.post(url(task), {"body": doc((str(alice.id), "Alice"))}, format="json").json()
    assert res["mentionsAll"] is False
    carol = add_project_member(project)
    edited = client.patch(f"/api/v1/comments/{res['id']}", {"body": doc(ALL)}, format="json").json()
    assert edited["mentionsAll"] is True
    assert set(edited["mentions"]) == {str(alice.id), str(bob.id), str(carol.id)}
    assert (mentioned(alice), mentioned(bob), mentioned(carol)) == (1, 1, 1)
