"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Archive, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { useLabels, useProjectMembers } from "@/features/projects/queries";
import { useRoles } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Project } from "@/lib/api/types";
import { useCan, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { replaceUrl, routes } from "@/lib/routes";
import { GeneralPanel } from "./project-general";
import { LabelsPanel } from "./project-labels";
import { isAdminRole } from "./project-lib";
import { MembersPanel } from "./project-members";
import { ReadOnlyNote } from "./project-parts";
import { WorkflowPanel } from "./project-workflow";

type Tab = "general" | "workflow" | "labels" | "members";
const TABS: Tab[] = ["general", "workflow", "labels", "members"];
const TAB_LABEL: Record<Tab, string> = { general: "General", workflow: "Workflow", labels: "Labels", members: "Members" };

/**
 * Project settings (board 28): General / Workflow / Labels / Members tabs. Each tab edits only
 * when the user holds its permission (project.update, status.manage, project.update,
 * project.manage_members); otherwise it renders read-only with the reason. Archive / delete
 * (project.archive / project.delete) live in General's danger zone; delete moves to the Trash.
 */
export function ProjectSettingsScreen() {
  return (
    <Suspense fallback={null}>
      <ProjectSettings />
    </Suspense>
  );
}

function ProjectSettings() {
  const project = useCurrentProject()!;
  const [deleted, setDeleted] = useState(false);
  if (deleted) return <DeletedState project={project} onRestored={() => setDeleted(false)} />;
  return <SettingsTabs project={project} onDeleted={() => setDeleted(true)} />;
}

function SettingsTabs({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const pathname = usePathname();
  const params = useSearchParams();
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "general";
  const setTab = (t: Tab) => {
    const sp = new URLSearchParams(params.toString());
    if (t === "general") sp.delete("tab");
    else sp.set("tab", t);
    const qs = sp.toString();
    replaceUrl(qs ? `${pathname}?${qs}` : pathname);
  };

  const archived = project.status === "archived";
  const canUpdate = useCan("project.update");
  const canStatuses = useCan("status.manage");
  const canMembers = useCan("project.manage_members");
  const canArchive = useCan("project.archive");
  const canDelete = useCan("project.delete");
  const edit: Record<Tab, boolean> = {
    general: canUpdate && !archived,
    workflow: canStatuses && !archived,
    labels: canUpdate && !archived,
    members: canMembers && !archived,
  };

  const roles = useRoles(ws.slug);
  const members = useProjectMembers(project.id);
  const labels = useLabels(project.id);
  const roleName = roles.data?.find((r) => r.id === project.myRoleId)?.name ?? "Member";
  const admins = (members.data ?? [])
    .filter((m) => isAdminRole(roles.data?.find((r) => r.id === m.roleId)))
    .map((m) => m.user);
  const fullAdmin = canUpdate && canStatuses && canMembers;

  const reason: Record<Tab, string> = archived
    ? { general: "archived projects are read-only", workflow: "archived projects are read-only", labels: "archived projects are read-only", members: "archived projects are read-only" }
    : {
        general: "your role can’t edit project details",
        workflow: "your role can’t change the workflow",
        labels: "your role can’t edit labels",
        members: "your role can’t manage members",
      };

  const [unarchiving, setUnarchiving] = useState(false);
  const unarchive = async () => {
    setUnarchiving(true);
    try {
      const next = await api.projects.unarchive(project.id);
      qc.setQueryData(qk.project(ws.slug, project.key), next);
      void qc.invalidateQueries({ queryKey: qk.projects(ws.slug) });
      void qc.invalidateQueries({ queryKey: qk.directory(ws.slug) });
      toast.success("Unarchived");
    } catch (e) {
      toast.error("Couldn’t unarchive", { body: errorMessage(e) });
    } finally {
      setUnarchiving(false);
    }
  };

  const idBase = "ps";
  return (
    <div className="flex min-h-full flex-col">
      <h1 className="sr-only">{project.name} settings</h1>
      <div className="flex flex-none items-center gap-3 overflow-x-auto border-b border-line px-6 [scrollbar-width:none] max-[760px]:px-3">
        <Tabs
          idBase={idBase}
          label="Project settings"
          value={tab}
          onChange={setTab}
          className="border-b-0 [&_[role=tab]]:h-[42px] max-[760px]:[&_[role=tab]]:h-[46px]"
          items={TABS.map((t) => ({
            value: t,
            label: TAB_LABEL[t],
            count: t === "labels" ? labels.data?.length : t === "members" ? (members.data?.length ?? project.memberCount) : undefined,
          }))}
        />
        <span className="flex-1" />
        {!fullAdmin && (
          <span className="inline-flex h-[22px] flex-none items-center rounded-[6px] border border-line bg-raised px-2 font-mono text-[11.5px] font-medium text-fg-2 max-[760px]:hidden">
            {roleName}
          </span>
        )}
      </div>

      <div className="mx-0 flex w-full max-w-[900px] flex-col px-8 pb-28 pt-6 max-[760px]:px-3.5 max-[760px]:pt-4">
        {archived && (
          <div role="status" className="mb-4 flex items-center gap-3 rounded-[10px] border border-line-2 bg-raised py-2.5 pl-3.5 pr-3">
            <Archive size={16} aria-hidden className="flex-none text-warn" />
            <span className="flex-1 font-semibold">
              Archived<span className="font-mono text-[11px] font-normal text-fg-3"> · read-only for everyone</span>
            </span>
            {canArchive && (
              <Button variant="secondary" size="sm" loading={unarchiving} onClick={() => void unarchive()}>
                Unarchive
              </Button>
            )}
          </div>
        )}
        <TabPanel idBase={idBase} value={tab} className="flex flex-col">
          {!edit[tab] && <ReadOnlyNote role={roleName} reason={reason[tab]} admins={admins} />}
          {tab === "general" && (
            <GeneralPanel project={project} canEdit={edit.general} canArchive={canArchive} canDelete={canDelete} onDeleted={onDeleted} />
          )}
          {tab === "workflow" && <WorkflowPanel project={project} canEdit={edit.workflow} />}
          {tab === "labels" && <LabelsPanel project={project} canEdit={edit.labels} />}
          {tab === "members" && <MembersPanel project={project} canEdit={edit.members} />}
        </TabPanel>
      </div>
    </div>
  );
}

/** "{name} moved to Trash" (board 28 isDeleted): restore in place or open the Trash. */
function DeletedState({ project, onRestored }: { project: Project; onRestored: () => void }) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    try {
      await api.trash.restore(ws.slug, [{ kind: "project", id: project.id }]);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.project(ws.slug, project.key) }),
        qc.invalidateQueries({ queryKey: qk.projects(ws.slug) }),
        qc.invalidateQueries({ queryKey: qk.directory(ws.slug) }),
        qc.invalidateQueries({ queryKey: qk.trash(ws.slug) }),
      ]);
      toast.success(`Restored ${project.name}`);
      onRestored();
    } catch (e) {
      toast.error("Couldn’t restore project", { body: errorMessage(e) });
      setBusy(false);
    }
  };
  return (
    <div role="status" className="flex flex-1 flex-col items-center justify-center gap-2.5 px-5 py-14 text-center animate-[fade-in_200ms_var(--ease)]">
      <span className="inline-flex size-11 items-center justify-center rounded-lg border border-line bg-raised text-danger">
        <Trash2 size={18} aria-hidden />
      </span>
      <h2 className="m-0 mt-1 text-[15px] font-semibold">{project.name} moved to Trash</h2>
      <span className="font-mono text-[11px] text-fg-3">30 days to restore</span>
      <div className="mt-1.5 flex gap-2">
        <Button variant="secondary" size="sm" loading={busy} onClick={() => void restore()}>
          Restore
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link href={routes.trash(ws.slug)}>Open Trash</Link>
        </Button>
      </div>
    </div>
  );
}
