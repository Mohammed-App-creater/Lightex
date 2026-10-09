"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Switch } from "@/components/ui/choice";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { StatusGlyph } from "@/components/ui/glyphs";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { DEV_ICON, DevGlyph } from "@/features/integrations/icons";
import { PROVIDER_NAME } from "@/features/integrations/lib/dev-lib";
import { useIntegrations } from "@/features/integrations/queries";
import { useStatuses } from "@/features/projects/queries";
import { SaveBar, type SaveState } from "@/features/settings/save-bar";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { DevAutomationRule, DevTrigger, Project } from "@/lib/api/types";
import { can, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";

const TRIGGER_TEXT: Record<DevTrigger, string> = {
  branch_created: "When a branch is created",
  pr_opened: "When a pull request is opened",
  pr_merged: "When a pull request is merged",
};
const TRIGGER_HINT: Record<DevTrigger, string> = {
  branch_created: "Only tasks still in a to-do status move.",
  pr_opened: "Only tasks still in a to-do status move.",
  pr_merged: "Moves when the last open pull request of the task merges.",
};

/** Same rules, same order, same values (the save bar's dirty check). */
export function sameRules(a: DevAutomationRule[], b: DevAutomationRule[]) {
  return a.length === b.length && a.every((r, i) => r.trigger === b[i]!.trigger && r.enabled === b[i]!.enabled && (r.statusId ?? null) === (b[i]!.statusId ?? null));
}

/**
 * Project settings → Development (§9.5, §11 #11): the repositories that apply to this project
 * (read-only; managers get a link to workspace settings) and the three automation rules, editable
 * with `status.manage` (otherwise the tab shows the ReadOnlyNote). pr_merged lists done-category
 * statuses only.
 */
export function DevelopmentSettingsPanel({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const rulesQ = useQuery({ queryKey: qk.devRules(project.id), queryFn: () => api.development.rules(project.id) });
  const overview = useIntegrations(ws.slug);
  const { data: statuses = [] } = useStatuses(project.id);
  const [draft, setDraft] = useState<DevAutomationRule[] | null>(null);
  const [state, setState] = useState<SaveState>("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const rules = draft ?? rulesQ.data ?? [];
  const dirty = draft !== null && rulesQ.data !== undefined && !sameRules(draft, rulesQ.data);

  const repos = (overview.data?.integrations ?? [])
    .filter((i) => i.status === "active")
    .flatMap((i) => i.repositories.filter((r) => r.allProjects || r.projectIds.includes(project.id)).map((r) => ({ ...r, provider: i.provider })));

  const patch = (i: number, p: Partial<DevAutomationRule>) => {
    const next = rules.map((r, k) => (k === i ? { ...r, ...p } : r));
    // Turning a rule on picks a sensible status (pr_merged: the first done one).
    if (p.enabled && !next[i]!.statusId) {
      const pool = next[i]!.trigger === "pr_merged" ? statuses.filter((s) => s.category === "done" && s.glyph !== "canceled") : statuses.filter((s) => s.category === "in_progress");
      next[i] = { ...next[i]!, statusId: pool[0]?.id ?? null };
    }
    setDraft(next);
    setErrors({});
    setState("dirty");
  };

  const save = async () => {
    if (!draft) return;
    setState("saving");
    try {
      const saved = await api.development.setRules(project.id, draft);
      qc.setQueryData(qk.devRules(project.id), saved);
      setDraft(null);
      setState("saved");
      toast.success("Automation saved");
      window.setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch (e) {
      const f = isApiError(e) ? ((e.details as { fields?: Record<string, string> } | undefined)?.fields ?? {}) : {};
      setErrors(f);
      setState("error");
      if (!Object.keys(f).length) toast.error("Couldn’t save the automation", { body: errorMessage(e) });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="dev-repos-h" className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <h2 id="dev-repos-h" className="m-0 text-[15px] font-semibold">
            Repositories
          </h2>
          <span className="font-mono text-[11px] text-fg-3">{repos.length}</span>
          <span className="flex-1" />
          {can("integration.manage", ws.my_permissions) && (
            <Link href={routes.settings(ws.slug, "integrations")} className="text-[12px] font-medium text-accent-t underline-offset-2 hover:underline">
              Manage in workspace settings
            </Link>
          )}
        </div>
        {overview.isPending ? (
          <Skeleton className="h-[76px] w-full" />
        ) : overview.isError ? (
          <ErrorState title="Couldn’t load repositories" body={errorMessage(overview.error)} onRetry={() => void overview.refetch()} />
        ) : repos.length === 0 ? (
          <p className="m-0 text-[12.5px] text-fg-3">No connected repository applies to {project.key}.</p>
        ) : (
          <ul className="m-0 list-none overflow-hidden rounded-[10px] border border-line p-0">
            {repos.map((r) => (
              <li key={r.id} className="flex h-[38px] items-center gap-2.5 border-t border-line px-3.5 text-fg-3 first:border-t-0">
                <DevGlyph d={DEV_ICON[r.provider]} size={14} strokeWidth={1.4} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                  {r.owner}/<b className="font-medium text-fg">{r.name}</b>
                </span>
                <span className="text-[11.5px]">{r.allProjects ? "All projects" : `${PROVIDER_NAME[r.provider]} · this project`}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="dev-rules-h" className="flex flex-col gap-2.5">
        <h2 id="dev-rules-h" className="m-0 text-[15px] font-semibold">
          Automation
        </h2>
        <p className="m-0 text-[12.5px] text-fg-3">Move tasks when linked work changes. Every rule is off until you turn it on; tasks only move forward.</p>
        {rulesQ.isPending ? (
          <Skeleton className="h-[150px] w-full" />
        ) : rulesQ.isError ? (
          <ErrorState title="Couldn’t load the automation" body={errorMessage(rulesQ.error)} onRetry={() => void rulesQ.refetch()} />
        ) : (
          <ul className="m-0 list-none overflow-hidden rounded-[10px] border border-line p-0">
            {rules.map((r, i) => {
              const pool = statuses.filter((s) => (r.trigger === "pr_merged" ? s.category === "done" : true));
              const err = errors[`rules.${i}.statusId`];
              return (
                <li key={r.trigger} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3.5 py-3 first:border-t-0">
                  <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
                    <span className="text-[13px] font-medium">{TRIGGER_TEXT[r.trigger]}</span>
                    <span className="text-[11.5px] text-fg-3">{TRIGGER_HINT[r.trigger]}</span>
                  </div>
                  <span className="text-[12px] text-fg-3">move to</span>
                  <div className="flex w-[190px] flex-col gap-1 max-[760px]:w-full">
                    <Select
                      label={`${TRIGGER_TEXT[r.trigger]}, move to`}
                      hideLabel
                      width={200}
                      disabled={!canEdit || !r.enabled}
                      value={r.statusId}
                      placeholder="Choose a status"
                      onChange={(v) => patch(i, { statusId: v })}
                      options={pool.map((s) => ({ value: s.id, label: s.name, icon: <StatusGlyph kind={s.glyph} color={s.color ?? undefined} /> }))}
                    />
                    {err && (
                      <span role="alert" className="text-[12px] text-danger">
                        {err}
                      </span>
                    )}
                  </div>
                  <Switch aria-label={`${TRIGGER_TEXT[r.trigger]}: ${r.enabled ? "on" : "off"}`} checked={r.enabled} disabled={!canEdit} onChange={(e) => patch(i, { enabled: e.target.checked })} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {canEdit && (
        <SaveBar
          state={dirty || state === "error" || state === "saving" || state === "saved" ? state : "idle"}
          onSave={() => void save()}
          onDiscard={() => {
            setDraft(null);
            setErrors({});
            setState("idle");
          }}
        />
      )}
    </div>
  );
}
