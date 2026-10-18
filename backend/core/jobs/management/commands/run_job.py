"""Runs a scheduled job for every workspace, or one (`--workspace`). `--list` shows the registered jobs."""

from django.core.management.base import BaseCommand, CommandError

from core.common.exceptions import ApiError
from core.jobs.registry import jobs
from core.jobs.services import FAILED, RAN, SKIPPED, run_job


class Command(BaseCommand):
    help = "Run a registered scheduled job: run_job <name> [--workspace ID], or run_job --list."

    def add_arguments(self, parser):
        parser.add_argument("name", nargs="?")
        parser.add_argument("--workspace", help="Only this workspace (id).")
        parser.add_argument("--list", action="store_true", help="List the registered jobs.")

    def handle(self, *args, **options):
        if options["list"]:
            for job in jobs():
                parts = [job.name, f"[{job.module or 'core'}]", job.schedule or "-", job.description]
                self.stdout.write("  ".join(parts).rstrip())
            return
        if not options["name"]:
            raise CommandError("Name a job (or pass --list).")
        try:
            result = run_job(options["name"], workspace_id=options["workspace"])
        except ApiError as exc:
            raise CommandError(exc.message) from exc
        for row in result.workspaces:
            self.stdout.write("  ".join([row["workspaceId"], row["status"], row.get("error", "")]).rstrip())
        summary = f"{result.job}: ran {result.count(RAN)}, skipped {result.count(SKIPPED)}"
        if result.count(FAILED):
            raise CommandError(f"{summary}, failed {result.count(FAILED)}")
        self.stdout.write(self.style.SUCCESS(summary))
