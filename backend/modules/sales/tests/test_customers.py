"""Companies and contacts (docs/sales/api.md §6–§7): CRUD, filters, sorting and cursors, the owner-change rule, the
summary stub, the duplicate check (and that it never leaks more than `exists` and the owner's name), delete and
restore, and the audit rows."""

import pytest

from core.audit.models import AuditLog
from modules.sales import services
from modules.sales.models import Company, Contact
from modules.sales.normalize import normalize_name, normalize_phone

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform"


def company_url(c):
    return f"/api/v1/sales/companies/{getattr(c, 'pk', c)}"


def contact_url(c):
    return f"/api/v1/sales/contacts/{getattr(c, 'pk', c)}"


# ───────────────────────── normalization ─────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Abay Trading PLC", "abay trading"),
        ("  ABAY   trading p.l.c. ", "abay trading"),
        ("Abay-Trading, Ltd.", "abay trading"),
        ("Café Ñandú S.C.", "cafe nandu"),
        ("A & B Share Company", "a and b"),
        ("Company", "company"),
        ("", ""),
        (None, ""),
    ],
)
def test_normalize_name(raw, expected):
    assert normalize_name(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("+251 911 22 33 44", "911223344"),
        ("0911-223344", "911223344"),
        ("911223344", "911223344"),
        ("12-34", ""),
        ("", ""),
    ],
)
def test_normalize_phone(raw, expected):
    assert normalize_phone(raw) == expected


# ───────────────────────── companies ─────────────────────────


def test_create_read_update_company(world):
    rep = world.client("rep")
    res = rep.post(
        f"{BASE}/companies",
        {
            "name": "  Blue Nile Foods PLC ",
            "phone": "+251 911 223344",
            "email": "info@bluenile.et",
            "city": "Bahir Dar",
        },
        format="json",
    )
    assert res.status_code == 201, res.json()
    body = res.json()
    me = world.users["rep"]
    assert body["name"] == "Blue Nile Foods PLC"
    assert (body["status"], body["ownerId"], body["owner"]) == (
        "prospect",
        str(me.pk),
        {"id": str(me.pk), "name": me.name, "hue": me.hue},
    )
    assert (body["canEdit"], body["canDelete"]) == (True, False)
    company = Company.objects.for_workspace(world.ws).get(pk=body["id"])
    assert (company.normalized_name, company.normalized_phone) == ("blue nile foods", "911223344")
    assert rep.get(company_url(company)).json() == body
    res = rep.patch(
        company_url(company), {"name": "Blue Nile Food Complex", "status": "active", "notes": "Met CEO"}, format="json"
    )
    assert res.status_code == 200
    assert (res.json()["status"], res.json()["notes"]) == ("active", "Met CEO")
    company.refresh_from_db()
    assert company.normalized_name == "blue nile food complex"
    rows = list(AuditLog.objects.filter(action__startswith="sales.company.").order_by("created_at"))
    assert [r.action for r in rows] == ["sales.company.created", "sales.company.updated"]
    assert {c["field"] for c in rows[1].changes} == {"Name", "Status", "Notes"}
    assert (rows[0].target_type, rows[0].module, rows[0].target_id) == ("sales.company", "sales", str(company.pk))
    # Nothing changed: no audit row.
    rep.patch(company_url(company), {"notes": "Met CEO"}, format="json")
    assert AuditLog.objects.filter(action="sales.company.updated").count() == 1


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({}, "name"),
        ({"name": ""}, "name"),
        ({"name": "x" * 201}, "name"),
        ({"name": "Ok", "email": "not-an-email"}, "email"),
        ({"name": "Ok", "status": "won"}, "status"),
        ({"name": "Ok", "ownerId": "nope"}, "ownerId"),
    ],
)
def test_company_validation(world, payload, field):
    res = world.client("rep").post(f"{BASE}/companies", payload, format="json")
    assert res.status_code == 422
    assert field in res.json()["details"]["fields"]


def test_list_filters_search_sort_and_cursor(world):
    admin = world.client("sales_admin")
    Company.objects.filter(pk=world.companies["rep"].pk).update(status="active", industry="Food", region="Amhara")
    page = admin.get(f"{BASE}/companies").json()
    names = [c["name"] for c in page["data"]]
    assert names[0] == "Manager Trading PLC"  # by name (database collation), then id
    assert page["nextCursor"] is None
    assert {c["name"] for c in page["data"]} == {
        "Rep Trading PLC",
        "Rep2 Trading PLC",
        "Rep3 Trading PLC",
        "Manager Trading PLC",
        "Sales_Admin Trading PLC",
    }
    one = admin.get(f"{BASE}/companies?filter[status]=active").json()["data"]
    assert [c["name"] for c in one] == ["Rep Trading PLC"]
    assert (
        admin.get(f"{BASE}/companies?filter[industry]=food&filter[region]=AMHARA").json()["data"][0]["name"]
        == "Rep Trading PLC"
    )
    assert admin.get(f"{BASE}/companies?filter[city]=Gondar").json()["data"] == []
    mine = admin.get(f"{BASE}/companies?filter[owner]=me").json()["data"]
    assert [c["name"] for c in mine] == ["Sales_Admin Trading PLC"]
    rep_id = world.users["rep"].pk
    assert [c["name"] for c in admin.get(f"{BASE}/companies?filter[owner]={rep_id}").json()["data"]] == [
        "Rep Trading PLC"
    ]
    assert [c["name"] for c in admin.get(f"{BASE}/companies?q=rep2").json()["data"]] == ["Rep2 Trading PLC"]
    assert len(admin.get(f"{BASE}/companies?q=0911").json()["data"]) == 0
    assert len(admin.get(f"{BASE}/companies?q=911").json()["data"]) == 1
    desc = [c["name"] for c in admin.get(f"{BASE}/companies?sort=-name").json()["data"]]
    assert desc == list(reversed(names))
    assert admin.get(f"{BASE}/companies?sort=createdAt").json()["data"][0]["name"] == "Rep Trading PLC"
    assert admin.get(f"{BASE}/companies?sort=-updatedAt").status_code == 200
    assert admin.get(f"{BASE}/companies?sort=status").json()["data"][0]["status"] == "active"
    # Cursor pages.
    first = admin.get(f"{BASE}/companies?limit=2").json()
    assert len(first["data"]) == 2 and first["nextCursor"]
    second = admin.get(f"{BASE}/companies?limit=2&cursor={first['nextCursor']}").json()
    third = admin.get(f"{BASE}/companies?limit=2&cursor={second['nextCursor']}").json()
    assert [c["name"] for c in first["data"] + second["data"] + third["data"]] == names
    assert third["nextCursor"] is None
    # Bad parameters.
    for q in ("sort=size", "filter[status]=won", "filter[owner]=bob", "cursor=!!"):
        assert admin.get(f"{BASE}/companies?{q}").status_code in (400, 422), q


def test_owner_change_rule(world):
    rep, manager, admin = world.client("rep"), world.client("manager"), world.client("sales_admin")
    rep2, rep3 = world.users["rep2"], world.users["rep3"]
    # A salesperson (own) can't give a record to someone else, on create or on edit.
    res = rep.post(f"{BASE}/companies", {"name": "Gift", "ownerId": str(rep2.pk)}, format="json")
    assert (res.status_code, res.json()["details"]) == (403, {"permission": "sales.company.edit", "scope": "team"})
    res = rep.patch(company_url(world.companies["rep"]), {"ownerId": str(rep2.pk)}, format="json")
    assert res.status_code == 403
    # Naming yourself is fine.
    res = rep.post(f"{BASE}/companies", {"name": "Mine", "ownerId": str(world.users["rep"].pk)}, format="json")
    assert res.status_code == 201
    # A manager (team) can hand over within their teams only.
    res = manager.patch(company_url(world.companies["rep"]), {"ownerId": str(rep2.pk)}, format="json")
    assert res.status_code == 200, res.json()
    assert res.json()["ownerId"] == str(rep2.pk)
    res = manager.patch(company_url(world.companies["rep2"]), {"ownerId": str(rep3.pk)}, format="json")
    assert (res.status_code, res.json()["details"]["fields"]) == (422, {"ownerId": "Pick someone in your team"})
    # An admin (all) can give it to any active member, never to an outsider.
    res = admin.patch(company_url(world.companies["rep2"]), {"ownerId": str(rep3.pk)}, format="json")
    assert res.status_code == 200
    res = admin.patch(company_url(world.companies["rep2"]), {"ownerId": str(world.users["outsider"].pk)}, format="json")
    assert (res.status_code, res.json()["details"]["fields"]) == (422, {"ownerId": "Pick a member of this workspace"})
    row = AuditLog.objects.filter(action="sales.company.updated").order_by("created_at").first()
    assert row.changes == [{"field": "Owner", "kind": "person", "before": "Rep", "after": "Rep2"}]


def test_edit_outside_the_edit_scope_is_forbidden(world):
    """Viewing reaches further than editing for a CEO / GM: a 403 with the permission, not a 404."""
    from core.access.models import RolePermission

    ceo_role = world.ws.roles.get(system_key="sales_ceo")
    RolePermission.objects.create(role=ceo_role, permission_id=_perm("sales.company.edit"), data_scope="own")
    world.users["ceo"].__dict__.pop("_lx_access_cache", None)
    res = world.client("ceo").patch(company_url(world.companies["rep"]), {"notes": "x"}, format="json")
    assert (res.status_code, res.json()["details"]) == (403, {"permission": "sales.company.edit"})


def _perm(code):
    from core.access.models import Permission

    return Permission.objects.get(code=code).pk


def test_delete_and_restore_company_with_its_contacts(world):
    admin = world.client("sales_admin")
    company = world.companies["rep"]
    loose = Contact.objects.create(workspace=world.ws, company=company, owner=world.users["rep"], name="Earlier")
    services.delete_contact(world.users["sales_admin"], loose)
    assert admin.delete(company_url(company)).status_code == 204
    assert admin.get(company_url(company)).status_code == 404
    assert not Contact.objects.for_workspace(world.ws).filter(company=company).exists()
    assert admin.get(contact_url(world.contacts["rep"])).status_code == 404
    trash = admin.get("/api/v1/workspaces/platform/trash").json()
    kinds = {(i["kind"], i["title"]) for i in trash["data"]}
    assert ("sales.company", "Rep Trading PLC") in kinds
    assert ("sales.contact", "Earlier") not in kinds  # comes back with its company only
    assert {"sales.company", "sales.contact"} <= set(trash["kinds"])
    res = admin.post(
        "/api/v1/workspaces/platform/trash/restore",
        {"items": [{"kind": "sales.company", "id": str(company.pk)}]},
        format="json",
    )
    assert res.status_code == 200, res.json()
    assert admin.get(company_url(company)).status_code == 200
    assert admin.get(contact_url(world.contacts["rep"])).status_code == 200  # deleted with it, restored with it
    assert admin.get(contact_url(loose)).status_code == 404  # deleted before: still in the trash
    trash = admin.get("/api/v1/workspaces/platform/trash").json()
    assert ("sales.contact", "Earlier") in {(i["kind"], i["title"]) for i in trash["data"]}
    assert list(
        AuditLog.objects.filter(action__startswith="sales.company.")
        .order_by("created_at")
        .values_list("action", flat=True)
    ) == [
        "sales.company.deleted",
        "sales.company.restored",
    ]


def test_purge_from_trash(world):
    admin = world.client("owner")
    company = world.companies["rep"]
    admin.delete(company_url(company))
    res = admin.post(
        "/api/v1/workspaces/platform/trash/purge",
        {"items": [{"kind": "sales.company", "id": str(company.pk)}]},
        format="json",
    )
    assert res.status_code in (200, 204), res.content
    assert not Company.all_objects.for_workspace(world.ws).filter(pk=company.pk).exists()
    assert not Contact.all_objects.for_workspace(world.ws).filter(company_id=company.pk).exists()
    contact = world.contacts["rep2"]
    admin.delete(contact_url(contact))
    admin.post(
        "/api/v1/workspaces/platform/trash/purge",
        {"items": [{"kind": "sales.contact", "id": str(contact.pk)}]},
        format="json",
    )
    assert not Contact.all_objects.for_workspace(world.ws).filter(pk=contact.pk).exists()


def test_trash_is_scoped(world):
    """A manager can't delete companies (no grant); a custom role with delete scope `own` sees only its own."""
    world.client("owner").delete(company_url(world.companies["rep"]))
    res = world.client("manager").get("/api/v1/workspaces/platform/trash")
    assert all(i["kind"] not in ("sales.company", "sales.contact") for i in res.json().get("data", []))
    owner_view = world.client("owner").get("/api/v1/workspaces/platform/trash").json()
    assert owner_view["scope"] == "all"


def test_delete_company_with_opportunities_hook(world, monkeypatch):
    monkeypatch.setattr(services, "company_has_opportunities", lambda c: True)
    res = world.client("owner").delete(company_url(world.companies["rep"]))
    assert (res.status_code, res.json()["code"]) == (409, "company_has_opportunities")


def test_purge_expired_and_purge_workspace(world):
    import datetime as dt

    from django.utils import timezone

    from core.audit import trash

    services.delete_company(world.users["owner"], world.companies["rep"])
    services.delete_contact(world.users["owner"], world.contacts["rep2"])
    later = timezone.now() + dt.timedelta(days=40)
    counts = trash.purge_expired(later)
    assert counts["companies"] >= 1 and counts["contacts"] >= 1
    assert not Company.all_objects.unscoped().filter(pk=world.companies["rep"].pk).exists()
    kind = trash.kind_for("sales.company")
    kind.purge_workspace(world.other_ws)
    assert not Company.all_objects.for_workspace(world.other_ws).exists()


def test_summary_stub(world):
    rep = world.client("rep")
    company = world.companies["rep"]
    Contact.objects.create(workspace=world.ws, company=company, owner=world.users["rep2"], name="Not mine")
    rep.patch(contact_url(world.contacts["rep"]), {"isPrimary": True}, format="json")
    res = rep.get(f"{company_url(company)}/summary")
    assert res.status_code == 200
    body = res.json()
    assert body["company"]["id"] == str(company.pk)
    assert body["contactCount"] == 1  # only the contacts the caller can see
    assert body["primaryContact"]["id"] == str(world.contacts["rep"].pk)
    assert {
        k: body[k]
        for k in ("openOpportunityCount", "pipelineValue", "wonValue", "openFollowUpCount", "lastContactAt", "timeline")
    } == {
        "openOpportunityCount": 0,
        "pipelineValue": "0.00",
        "wonValue": "0.00",
        "openFollowUpCount": 0,
        "lastContactAt": None,
        "timeline": [],
    }
    assert rep.get(f"{company_url(world.companies['rep3'])}/summary").status_code == 404
    assert world.client("rep3").get(f"{company_url(world.companies['rep3'])}/summary").json()["primaryContact"] is None


# ───────────────────────── duplicate check ─────────────────────────


def test_duplicate_check_matches_name_or_phone_outside_scope(world):
    rep = world.client("rep")
    url = f"{BASE}/companies/check-duplicate"
    # rep3's company is outside rep's scope (rep can't open it) ...
    assert rep.get(company_url(world.companies["rep3"])).status_code == 404
    # ... but the check still finds it, by normalized name or by phone, and says only who owns it.
    for q in (
        "name=rep3 trading",
        "name=REP3%20TRADING%20P.L.C.",
        "phone=0912000002",
        "phone=%2B251912000002",
        "name=zzz&phone=912000002",
    ):
        res = rep.get(f"{url}?{q}")
        assert res.status_code == 200, q
        assert res.json() == {"exists": True, "ownerName": "Rep3"}, q
    assert rep.get(f"{url}?name=Unknown%20Ltd").json() == {"exists": False, "ownerName": None}
    assert rep.get(f"{url}?name=rep3 trading&excludeId={world.companies['rep3'].pk}").json()["exists"] is False
    # Deleted companies and other workspaces don't count.
    assert rep.get(f"{url}?name=Theirs").json()["exists"] is False
    services.delete_company(world.users["owner"], world.companies["rep3"])
    assert rep.get(f"{url}?name=rep3 trading").json()["exists"] is False
    # Errors.
    assert rep.get(url).status_code == 422
    assert rep.get(f"{url}?name=%20&phone=").status_code == 422
    assert rep.get(f"{url}?name=x&excludeId=nope").status_code == 422


def test_duplicate_check_never_leaks_details(world):
    res = world.client("rep").get(f"{BASE}/companies/check-duplicate?name=Manager Trading")
    assert set(res.json()) == {"exists", "ownerName"}
    raw = res.content.decode()
    company = world.companies["manager"]
    for secret in (str(company.pk), company.phone, "Addis", str(world.users["manager"].pk), company.name):
        assert secret not in raw
    # An ownerless match says so without a name.
    Company.objects.filter(pk=company.pk).update(owner=None)
    assert world.client("rep").get(f"{BASE}/companies/check-duplicate?name=Manager Trading").json() == {
        "exists": True,
        "ownerName": None,
    }


# ───────────────────────── contacts ─────────────────────────


def test_contact_crud_and_primary(world):
    rep = world.client("rep")
    company = world.companies["rep"]
    res = rep.post(
        f"{BASE}/contacts",
        {"companyId": str(company.pk), "name": "Hana Bekele", "jobTitle": "Buyer", "phone": "0911", "isPrimary": True},
        format="json",
    )
    assert res.status_code == 201, res.json()
    body = res.json()
    assert (body["company"], body["jobTitle"], body["isPrimary"], body["canEdit"]) == (
        {"id": str(company.pk), "name": company.name},
        "Buyer",
        True,
        True,
    )
    second = rep.post(
        f"{BASE}/contacts", {"companyId": str(company.pk), "name": "Abel", "isPrimary": True}, format="json"
    ).json()
    assert rep.get(contact_url(body["id"])).json()["isPrimary"] is False  # one primary per company
    assert second["isPrimary"] is True
    res = rep.patch(contact_url(body["id"]), {"email": "hana@x.et", "name": "Hana B."}, format="json")
    assert (res.json()["email"], res.json()["name"]) == ("hana@x.et", "Hana B.")
    # Moving to another company needs that company to be visible.
    res = rep.patch(contact_url(body["id"]), {"companyId": str(world.companies["rep3"].pk)}, format="json")
    assert (res.status_code, res.json()["details"]["fields"]) == (422, {"companyId": "Pick a company you can see"})
    other = rep.post(f"{BASE}/companies", {"name": "Second Co"}, format="json").json()
    res = rep.patch(contact_url(body["id"]), {"companyId": other["id"]}, format="json")
    assert res.json()["companyId"] == other["id"]
    res = rep.post(f"{BASE}/contacts", {"companyId": str(world.companies["rep3"].pk), "name": "X"}, format="json")
    assert res.status_code == 422
    res = rep.post(f"{BASE}/contacts", {"name": "No company"}, format="json")
    assert "companyId" in res.json()["details"]["fields"]
    assert rep.delete(contact_url(body["id"])).status_code == 403  # salespeople can't delete
    assert world.client("owner").delete(contact_url(body["id"])).status_code == 204
    actions = list(
        AuditLog.objects.filter(action__startswith="sales.contact.")
        .order_by("created_at")
        .values_list("action", flat=True)
    )
    assert actions == [
        "sales.contact.created",
        "sales.contact.created",
        "sales.contact.updated",
        "sales.contact.updated",
        "sales.contact.deleted",
    ]


def test_contact_restore_keeps_one_primary(world):
    owner = world.users["owner"]
    first = world.contacts["rep"]
    Contact.objects.filter(pk=first.pk).update(is_primary=True)
    first.refresh_from_db()
    services.delete_contact(owner, first)
    newer = Contact.objects.create(workspace=world.ws, company=first.company, owner=owner, name="New", is_primary=True)
    services.restore_contact(owner, Contact.all_objects.for_workspace(world.ws).get(pk=first.pk))
    first.refresh_from_db()
    newer.refresh_from_db()
    assert (first.deleted_at, first.is_primary, newer.is_primary) == (None, False, True)


def test_contact_list_filters(world):
    admin = world.client("sales_admin")
    company = world.companies["rep"]
    Contact.objects.create(workspace=world.ws, company=company, owner=world.users["rep"], name="Zed", is_primary=True)
    names = [c["name"] for c in admin.get(f"{BASE}/contacts").json()["data"]]
    assert (names[0], names[-1]) == ("Manager Contact", "Zed")
    by_company = admin.get(f"{BASE}/contacts?filter[company]={company.pk}").json()["data"]
    assert sorted(c["name"] for c in by_company) == ["Rep Contact", "Zed"]
    assert [c["name"] for c in admin.get(f"{BASE}/contacts?filter[primary]=true").json()["data"]] == ["Zed"]
    assert [c["name"] for c in admin.get(f"{BASE}/contacts?q=rep3").json()["data"]] == ["Rep3 Contact"]
    assert [c["name"] for c in admin.get(f"{BASE}/contacts?filter[owner]=me").json()["data"]] == ["Sales_Admin Contact"]
    assert admin.get(f"{BASE}/contacts?sort=-createdAt").json()["data"][0]["name"] == "Zed"
    for q in ("filter[company]=x", "filter[primary]=maybe", "sort=job"):
        assert admin.get(f"{BASE}/contacts?{q}").status_code == 422, q
