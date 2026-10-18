"""Sales on the platform services (docs/sales/api.md §8): comments on `sales.company` / `sales.contact` targets
(scoped), search (scoped), the audit filter groups, and the module-disabled behavior (403, data kept)."""

import pytest

from core.collab.models import Comment
from core.common.targets import get_resolver
from core.modules.services import set_module_enabled
from modules.sales.models import Company, Contact

pytestmark = pytest.mark.django_db

DOC = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Called them"}]}]}


def comments_url(kind, obj):
    return f"/api/v1/targets/sales.{kind}/{obj.pk}/comments"


# ───────────────────────── collab ─────────────────────────


def test_comments_on_companies_follow_the_data_scope(world):
    company = world.companies["rep"]
    url = comments_url("company", company)
    res = world.client("rep").post(url, {"body": DOC}, format="json")
    assert res.status_code == 201, res.json()
    assert (res.json()["targetType"], res.json()["targetId"]) == ("sales.company", str(company.pk))
    assert len(world.client("manager").get(url).json()) == 1  # team scope reaches rep's company
    assert world.client("ceo").post(url, {"body": DOC}, format="json").status_code == 201  # view scope is enough
    for actor in ("rep3", "member", "outsider"):
        assert world.client(actor).get(url).status_code == 404, actor
        assert world.client(actor).post(url, {"body": DOC}, format="json").status_code == 404, actor
    # Deleting someone else's comment needs edit scope on the record.
    ceo_comment = Comment.objects.for_workspace(world.ws).filter(author=world.users["ceo"]).get()
    assert world.client("rep").delete(f"/api/v1/comments/{ceo_comment.pk}").status_code == 204
    rep_comment = Comment.objects.for_workspace(world.ws).filter(author=world.users["rep"]).get()
    assert world.client("ceo").delete(f"/api/v1/comments/{rep_comment.pk}").status_code == 403
    assert world.client("manager").delete(f"/api/v1/comments/{rep_comment.pk}").status_code == 204


def test_comments_on_contacts_and_resolver_details(world):
    contact = world.contacts["rep"]
    res = world.client("rep").post(comments_url("contact", contact), {"body": DOC}, format="json")
    assert res.status_code == 201
    assert world.client("rep2").get(comments_url("contact", contact)).status_code == 404
    resolver = get_resolver("sales.contact")
    assert resolver.describe(contact.pk)["title"] == "Rep Contact"
    assert resolver.describe(contact.pk)["link"].endswith(f"/platform/sales/contacts/{contact.pk}")
    assert resolver.subscribers(contact.pk) == [world.users["rep"].pk]
    assert set(resolver.visible_ids(world.users["rep"], world.ws)) == {contact.pk}
    assert resolver.visible_ids(world.users["rep"]) is None
    assert resolver.exists(world.ws, contact.pk) and not resolver.exists(world.other_ws, contact.pk)
    company = get_resolver("sales.company")
    assert company.describe(world.companies["rep"].pk)["title"] == "Rep Trading PLC"
    assert company.describe("nope") == {} and company.workspace_of("nope") is None
    assert company.record_exists(world.companies["rep"].pk)
    # A contact of a deleted company is no longer a target.
    Company.objects.filter(pk=world.companies["rep"].pk).update(deleted_at=world.companies["rep"].created_at)
    assert resolver.workspace_of(contact.pk) is None
    assert world.client("rep").get(comments_url("contact", contact)).status_code == 404


def test_deleted_comment_trash_access(world):
    url = comments_url("company", world.companies["rep"])
    cid = world.client("rep").post(url, {"body": DOC}, format="json").json()["id"]
    assert world.client("rep").delete(f"/api/v1/comments/{cid}").status_code == 204
    resolver = get_resolver("sales.company")
    assert resolver.comment_trash_access(world.users["rep"], world.ws) == "own"
    assert resolver.comment_trash_access(world.users["rep3"], world.ws) == "none"


# ───────────────────────── search ─────────────────────────


def search(world, actor, q, kind):
    res = world.client(actor).get(f"/api/v1/workspaces/platform/search?q={q}&filter[type]={kind}")
    assert res.status_code == 200, res.json()
    return {r["title"] for r in res.json()}


def test_workspace_search_is_scoped(world):
    assert search(world, "rep", "trading", "company") == {"Rep Trading PLC"}
    assert search(world, "manager", "trading", "company") == {
        "Rep Trading PLC",
        "Rep2 Trading PLC",
        "Manager Trading PLC",
    }
    assert len(search(world, "ceo", "trading", "company")) == 5
    assert search(world, "rep", "contact", "contact") == {"Rep Contact"}
    assert search(world, "member", "trading", "company") == set()  # no sales grant
    hit = world.client("rep").get("/api/v1/workspaces/platform/search?q=rep&filter[type]=company").json()[0]
    assert hit["type"] == "company" and hit["targetType"] == "sales.company"
    assert hit["company"] == {
        "id": str(world.companies["rep"].pk),
        "name": "Rep Trading PLC",
        "status": "prospect",
        "city": "Addis Ababa",
    }
    assert hit["link"].endswith(f"/platform/sales/companies/{world.companies['rep'].pk}")
    contact = world.client("rep").get("/api/v1/workspaces/platform/search?q=&filter[type]=contact").json()
    assert [c["contact"]["companyName"] for c in contact] == ["Rep Trading PLC"]


def test_global_search_is_scoped_and_skips_disabled_workspaces(world):
    res = world.client("rep").get("/api/v1/search?q=trading&type=company").json()["data"]
    assert {r["title"] for r in res} == {"Rep Trading PLC"}
    res = world.client("outsider").get("/api/v1/search?q=their&type=contact").json()["data"]
    assert {r["title"] for r in res} == {"Their Contact"}
    set_module_enabled(world.users["outsider"], world.other_ws, "sales", False)
    assert world.client("outsider").get("/api/v1/search?q=their&type=contact").json()["data"] == []


# ───────────────────────── audit groups ─────────────────────────


def test_audit_filter_groups(world):
    rep = world.client("rep")
    rep.patch(f"/api/v1/sales/companies/{world.companies['rep'].pk}", {"notes": "x"}, format="json")
    world.client("owner").post("/api/v1/sales/workspaces/platform/products", {"name": "P"}, format="json")
    audit = world.client("owner")
    rows = audit.get("/api/v1/workspaces/platform/audit?filter[entity]=company").json()["data"]
    assert [r["action"] for r in rows] == ["sales.company.updated"]
    rows = audit.get("/api/v1/workspaces/platform/audit?filter[entity]=sales_settings").json()["data"]
    assert [r["action"] for r in rows] == ["sales.product.created"]


# ───────────────────────── module disabled ─────────────────────────


def test_module_disabled_answers_403_and_keeps_data(world):
    owner = world.users["owner"]
    company = world.companies["rep"]
    world.client("rep").post(comments_url("company", company), {"body": DOC}, format="json")
    set_module_enabled(owner, world.ws, "sales", False)
    for actor in ("owner", "rep"):
        client = world.client(actor)
        for url in (
            "/api/v1/sales/workspaces/platform/companies",
            "/api/v1/sales/workspaces/platform/settings",
            f"/api/v1/sales/companies/{company.pk}",
            f"/api/v1/sales/contacts/{world.contacts['rep'].pk}",
            f"/api/v1/sales/companies/{company.pk}/summary",
        ):
            res = client.get(url)
            assert (res.status_code, res.json()["code"]) == (403, "module_disabled"), (actor, url)
        res = client.post("/api/v1/sales/workspaces/platform/companies", {"name": "X"}, format="json")
        assert res.json()["code"] == "module_disabled"
    assert world.client("outsider").get(f"/api/v1/sales/companies/{company.pk}").status_code == 404  # membership first
    assert world.client("rep").get(comments_url("company", company)).status_code == 404
    assert search(world, "owner", "trading", "company") == set()
    assert Company.objects.for_workspace(world.ws).count() == 5
    assert Contact.objects.for_workspace(world.ws).count() == 5
    set_module_enabled(owner, world.ws, "sales", True)
    assert world.client("rep").get(f"/api/v1/sales/companies/{company.pk}").status_code == 200
    assert len(world.client("rep").get(comments_url("company", company)).json()) == 1


def test_all_mention_respects_the_data_scope(world):
    from core.notifications.models import Notification

    company = world.companies["rep"]
    body = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "mention", "attrs": {"id": "all", "label": "all"}}]}]}  # fmt: skip
    res = world.client("rep").post(comments_url("company", company), {"body": body}, format="json")
    assert res.status_code == 201 and res.json()["mentionsAll"] is True
    notified = set(Notification.objects.unscoped().filter(kind="mention").values_list("recipient_id", flat=True))
    assert set(map(str, notified)) == set(res.json()["mentions"])
    assert world.users["manager"].pk in notified and world.users["ceo"].pk in notified
    for actor in ("rep", "rep3", "member", "outsider"):
        assert world.users[actor].pk not in notified, actor
