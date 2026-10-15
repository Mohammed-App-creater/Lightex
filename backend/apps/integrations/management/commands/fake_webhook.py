"""Board 37 §7.8: post a provider-shaped, really signed webhook through the full receiver path.

python manage.py fake_webhook --provider github --event pr_merged --key PRJ-42 [--workspace platform]
"""

from django.core.management.base import BaseCommand, CommandError
from django.test import Client

from apps.integrations import fake_payloads, runner
from apps.integrations.models import Integration


class Command(BaseCommand):
    help = "Send a signed fake GitHub/GitLab webhook (pr_opened, pr_merged, checks_failed, push) for a task key."

    def add_arguments(self, parser):
        parser.add_argument("--provider", choices=["github", "gitlab"], default="github")
        parser.add_argument("--event", choices=fake_payloads.EVENTS, required=True)
        parser.add_argument("--key", required=True, help="Task key named in the PR, branch or commit, e.g. PRJ-42")
        parser.add_argument("--workspace", default="platform", help="Workspace slug")

    def handle(self, *args, **options):
        integration = (
            Integration.objects.filter(
                workspace__slug=options["workspace"], provider=options["provider"], status__in=("active", "error")
            )
            .order_by("created_at")
            .first()
        )
        if integration is None:
            raise CommandError(f"No {options['provider']} integration in workspace {options['workspace']}.")
        repo = integration.repositories.order_by("full_path").first()
        if repo is None:
            raise CommandError("The integration tracks no repository.")
        key = options["key"].upper()
        if integration.provider == "github":
            event, payload = fake_payloads.github_payload(repo, integration, options["event"], key)
        else:
            event, payload = fake_payloads.gitlab_payload(repo, options["event"], key)
        res = fake_payloads.post(Client(SERVER_NAME="localhost"), integration, event, payload)
        runner.drain()
        self.stdout.write(f"{event} → {res.status_code} {res.content.decode()[:200]}")
