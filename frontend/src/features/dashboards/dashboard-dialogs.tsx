"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Radio } from "@/components/ui/choice";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { Dashboard, DashboardTemplate, DashboardVisibility, Project } from "@/lib/api/types";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { useCreateDashboard, useUpdateDashboard } from "./queries";

/* New / rename dialogs and the delete confirm (spec §1.6). */

const fieldErr = (e: unknown, field: string) => (isApiError(e) ? e.fieldErrors[field] : undefined);

export function NewDashboardDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (o: boolean) => void }) {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const create = useCreateDashboard(project.id);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<DashboardVisibility>("shared");
  const [template, setTemplate] = useState<DashboardTemplate>("sprint_health");
  const [error, setError] = useState<string | null>(null);

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setName("");
      setError(null);
      setVisibility("shared");
      setTemplate("sprint_health");
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Name is required");
    try {
      const d = await create.mutateAsync({ name: trimmed, visibility, template });
      close(false);
      toast.success(`Created “${d.name}”`);
      router.push(routes.dashboard(ws.slug, project.key, d.id));
    } catch (err) {
      setError(fieldErr(err, "name") ?? errorMessage(err));
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="New dashboard"
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-dashboard" loading={create.isPending}>
            Create dashboard
          </Button>
        </>
      }
    >
      <form id="new-dashboard" onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2">Name</span>
          <Input
            autoFocus
            value={name}
            maxLength={60}
            placeholder="Sprint 14 health"
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? "new-dashboard-error" : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
          {error && (
            <span id="new-dashboard-error" role="alert" className="text-[12px] text-danger">
              {error}
            </span>
          )}
        </label>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1.5 text-[12px] font-medium text-fg-2">Visibility</legend>
          <Radio name="visibility" label="Shared with project" checked={visibility === "shared"} onChange={() => setVisibility("shared")} />
          <Radio name="visibility" label="Only me" checked={visibility === "personal"} onChange={() => setVisibility("personal")} />
        </fieldset>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1.5 text-[12px] font-medium text-fg-2">Start from</legend>
          <Radio name="template" label="Blank" checked={template === "blank"} onChange={() => setTemplate("blank")} />
          <Radio name="template" label="Sprint health" checked={template === "sprint_health"} onChange={() => setTemplate("sprint_health")} />
        </fieldset>
      </form>
    </Modal>
  );
}

export function RenameDashboardDialog({ dashboard, open, onOpenChange }: { dashboard: Dashboard; open: boolean; onOpenChange: (o: boolean) => void }) {
  const update = useUpdateDashboard();
  const [name, setName] = useState(dashboard.name);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Name is required");
    if (trimmed === dashboard.name) return onOpenChange(false);
    try {
      await update.mutateAsync({ d: dashboard, patch: { name: trimmed } });
      onOpenChange(false);
    } catch (err) {
      if (isApiError(err) && err.code === "version_conflict") {
        onOpenChange(false);
        toast({ tone: "warning", title: "Someone else changed this dashboard", body: "We reloaded it. Try again." });
        return;
      }
      setError(fieldErr(err, "name") ?? errorMessage(err));
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Rename dashboard"
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="rename-dashboard" loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="rename-dashboard" onSubmit={submit} className="flex flex-col gap-1.5">
        <Input
          autoFocus
          aria-label="Name"
          value={name}
          maxLength={60}
          aria-invalid={Boolean(error) || undefined}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        {error && (
          <span role="alert" className="text-[12px] text-danger">
            {error}
          </span>
        )}
      </form>
    </Modal>
  );
}

export function DeleteDashboardDialog({ dashboard, open, onOpenChange, onConfirm }: { dashboard: Dashboard; open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => void }) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      role="alertdialog"
      width={420}
      title={`Delete “${dashboard.name}”?`}
      description={dashboard.visibility === "shared" ? "It disappears for everyone on this project." : "Only you can see it."}
      footer={
        <>
          <Button variant="ghost" autoFocus onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Delete dashboard
          </Button>
        </>
      }
    />
  );
}
