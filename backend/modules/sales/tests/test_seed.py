"""S7 `seed_demo_sales`: one run on a fresh workspace gives the spec's demo data (docs/sales/spec.md §13)."""

from io import StringIO

import pytest
from django.core.management import call_command

from core.access import services as access
from core.accounts.models import User
from core.teams.models import Team
from core.workspaces.models import Workspace
from modules.sales import seed
from modules.sales.models import DailyReport, Lead, Opportunity, PipelineStage, Quotation, Target

pytestmark = pytest.mark.django_db


def test_seed_demo_sales_on_a_fresh_workspace():
    call_command("seed_demo_sales", "--workspace", "seed-test", "--force", stdout=StringIO())
    ws = Workspace.objects.get(slug="seed-test")
    counts = seed._Seeder(ws, None, None).summary() | {"users": 7}
    assert (counts["companies"], counts["leads"], counts["opportunities"]) == (20, 40, 60)
    assert counts["contacts"] >= 20
    assert counts["won"] == 14 and counts["lost"] == 10
    assert counts["quotations"] > 0 and counts["activities"] > 60
    assert counts["overdueFollowUps"] > 0 and counts["holidays"] >= 5
    assert set(Team.objects.filter(workspace=ws).values_list("name", flat=True)) == {"North", "South"}
    opps = Opportunity.objects.for_workspace(ws)
    assert set(opps.values_list("stage__category", flat=True)) == {"open", "won", "lost"}
    assert {s.name for s in PipelineStage.objects.for_workspace(ws)} == set(opps.values_list("stage__name", flat=True))
    assert opps.filter(stage__category="won").values_list("won_at", flat=True).count() == 14
    assert Lead.objects.for_workspace(ws).filter(status="qualified").exists()
    assert Quotation.objects.for_workspace(ws).filter(status="accepted").exists()
    assert set(Target.objects.for_workspace(ws).values_list("period_type", flat=True)) == {"year", "quarter", "month"}
    reports = DailyReport.objects.for_workspace(ws)
    assert reports.filter(status="reviewed").exists() and reports.filter(status="submitted").exists()
    abel = User.objects.get(email="abel@sales.demo")
    assert {r.system_key for r in ws.members.get(user=abel).role_list()} >= {"member", "sales_salesperson"}
    assert access.can(abel, "sales.dailyreport.submit", ws)

    out = StringIO()
    call_command("seed_demo_sales", "--workspace", "seed-test", "--force", stdout=out)  # idempotent
    assert "nothing to do" in out.getvalue()
    assert Opportunity.objects.for_workspace(ws).count() == 60
