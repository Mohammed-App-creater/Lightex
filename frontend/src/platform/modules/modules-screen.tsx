"use client";

import { Boxes, Lock, Puzzle, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import { Switch } from "@/ui/choice";
import { EmptyState, ErrorState, Skeleton } from "@/ui/feedback";
import { ConfirmDialog } from "@/ui/modal";
import { toast } from "@/ui/toast";
import { isForbidden } from "@/api/errors";
import type { WorkspaceModule } from "@/api/types";
import { shortDate } from "@/lib/utils/dates";
import { SettingsPage } from "@/platform/settings/settings-shell";
import { useCan, useCurrentWorkspace } from "@/platform/roles/can";
import { MODULES } from "@/registry";
import { moduleToggleError, sortModules } from "./lib";
import { useModules, useSetModule } from "./queries";

/*
 * Settings → Modules (docs/platform/stage3-contract.md §5, docs/platform-architecture.md §11): one toggle card per
 * module. Turning one off asks for confirmation (its data is kept); non-toggleable modules (core, tracking) show as
 * always on. Gated by core.modules.manage: the nav item is hidden without it, and the page says so.
 */

const ICONS: Record<string, LucideIcon> = { core: Boxes, ...Object.fromEntries(MODULES.map((m) => [m.key, m.icon])) };

export function ModulesScreen() {
  const ws = useCurrentWorkspace()!;
  const allowed = useCan("core.modules.manage");
  const modules = useModules(ws.slug, allowed);
  const setModule = useSetModule(ws.slug);
  const [confirm, setConfirm] = useState<WorkspaceModule | null>(null);

  if (!allowed || (modules.isError && isForbidden(modules.error))) {
    return (
      <SettingsPage title="Modules">
        <EmptyState
          illustration="denied"
          title="Only owners and admins can manage modules"
          body="Ask a workspace owner or admin to turn modules on or off."
        />
      </SettingsPage>
    );
  }

  const list = sortModules(modules.data ?? []);
  const toggle = (mod: WorkspaceModule, enabled: boolean) =>
    setModule.mutate(
      { key: mod.key, enabled },
      {
        onSuccess: (m) => toast.success(`${m.name} turned ${m.enabled ? "on" : "off"}`),
        onError: (err) => toast.error(...toToast(moduleToggleError(err, mod, enabled, list))),
      },
    );

  return (
    <SettingsPage title="Modules">
      <p className="m-0 -mt-2 mb-5 max-w-[560px] text-[13px] leading-5 text-fg-2">
        Choose what {ws.name} uses. Turning a module off hides it for everyone; its data and role settings are kept.
      </p>
      {modules.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading modules" className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex items-center gap-3.5 p-4">
              <Skeleton className="size-10 rounded-[10px]" />
              <span className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2.5 w-[60%]" />
              </span>
              <Skeleton className="h-5 w-9 rounded-full" />
            </Card>
          ))}
        </div>
      ) : modules.isError ? (
        <ErrorState title="Couldn’t load modules" onRetry={() => void modules.refetch()} retrying={modules.isFetching} />
      ) : list.length === 0 ? (
        <EmptyState icon={<Puzzle size={20} strokeWidth={1.5} aria-hidden />} title="No modules" body="This workspace has no modules to manage." />
      ) : (
        <ul role="list" className="m-0 flex list-none flex-col gap-3 p-0">
          {list.map((m) => (
            <ModuleCard
              key={m.key}
              mod={m}
              all={list}
              onToggle={(on) => (on ? toggle(m, true) : setConfirm(m))}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Turn off ${confirm?.name ?? "this module"}?`}
        description={`${confirm?.name ?? "It"} disappears from the sidebar, search and roles for everyone in ${ws.name}. Its data and role settings are kept, and turning it back on restores everything.`}
        confirmLabel="Turn off"
        confirmVariant="danger"
        onConfirm={() => {
          if (confirm) toggle(confirm, false);
        }}
      />
    </SettingsPage>
  );
}

const toToast = (t: { title: string; body: string }) => [t.title, { body: t.body }] as const;

function ModuleCard({ mod, all, onToggle }: { mod: WorkspaceModule; all: WorkspaceModule[]; onToggle: (on: boolean) => void }) {
  const look = { icon: ICONS[mod.key] ?? Puzzle };
  const needs = mod.dependsOn.map((k) => all.find((m) => m.key === k)?.name ?? k);
  const id = `module-${mod.key}`;
  return (
    <li>
      <Card className="flex items-start gap-3.5 p-4 max-[760px]:gap-3">
        <span aria-hidden className="flex size-10 flex-none items-center justify-center rounded-[10px] border border-line-2 bg-raised text-fg-2">
          <look.icon size={18} strokeWidth={1.5} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span id={`${id}-name`} className="text-[14px] font-semibold">
              {mod.name}
            </span>
            {!mod.toggleable && (
              <Badge>
                <Lock size={11} aria-hidden /> Always on
              </Badge>
            )}
            {needs.length > 0 && <Badge>Needs {needs.join(", ")}</Badge>}
          </span>
          <span id={`${id}-desc`} className="text-[13px] leading-5 text-fg-2">
            {mod.description}
          </span>
          {mod.toggleable && mod.enabled && mod.enabledAt && (
            <span className="font-mono text-[11px] text-fg-3">On since {shortDate(mod.enabledAt.slice(0, 10))}</span>
          )}
        </span>
        {mod.toggleable && (
          <span className="flex min-h-11 flex-none items-center">
            <Switch
              checked={mod.enabled}
              aria-labelledby={`${id}-name`}
              aria-describedby={`${id}-desc`}
              onChange={(e) => onToggle(e.target.checked)}
            />
          </span>
        )}
      </Card>
    </li>
  );
}
