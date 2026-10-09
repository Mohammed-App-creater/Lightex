"use client";

import * as Popover from "@radix-ui/react-popover";
import { Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { Segmented, Switch } from "@/components/ui/choice";
import { Select } from "@/components/ui/select";
import { useCustomFields } from "@/features/fields/queries";
import { useObjectives, useSprints } from "@/features/projects/queries";
import type { DashboardWidget, WidgetConfigMap, WidgetType } from "@/lib/api/types";
import { WIDGET_NAME } from "@/lib/domain/dashboards";

/*
 * Widget settings (spec §1.4 / §3.3): a gear in edit mode, only for types with options. Changes
 * apply to the draft at once; Save layout sends them with the layout.
 */

export const HAS_SETTINGS: Record<WidgetType, boolean> = {
  burndown: true,
  my_tasks: true,
  objectives: true,
  workload: true,
  velocity: true,
  activity: false,
};

const ACTIVE = "__active";
const ALL = "__all";
const ASSIGNEE = "__assignee";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-medium text-fg-3">{label}</span>
      {children}
    </div>
  );
}

export function WidgetSettings({ widget, projectId, onChange }: { widget: DashboardWidget; projectId: string; onChange: (config: DashboardWidget["config"]) => void }) {
  const { data: sprints = [] } = useSprints(projectId);
  const { data: objectives = [] } = useObjectives(projectId);
  const { data: fields = [] } = useCustomFields(projectId);
  const sprintOptions = [{ value: ACTIVE, label: "Active sprint" }, ...sprints.map((s) => ({ value: s.id, label: s.name }))];
  const quarters = [...new Set(objectives.map((o) => o.quarter).filter(Boolean))].sort();
  const name = WIDGET_NAME[widget.type];

  let body: ReactNode = null;
  switch (widget.type) {
    case "burndown": {
      const c = widget.config;
      body = (
        <Row label="Sprint">
          <Select label="Sprint" hideLabel value={c.sprintId ?? ACTIVE} options={sprintOptions} onChange={(v) => onChange({ sprintId: v === ACTIVE ? null : v })} width={220} />
        </Row>
      );
      break;
    }
    case "my_tasks": {
      const c = widget.config;
      body = <Switch label="Show tasks done in the last 7 days" checked={c.showDone} onChange={(e) => onChange({ showDone: e.target.checked })} />;
      break;
    }
    case "objectives": {
      const c = widget.config;
      body = (
        <Row label="Quarter">
          <Select
            label="Quarter"
            hideLabel
            value={c.quarter ?? ALL}
            options={[{ value: ALL, label: "All quarters" }, ...quarters.map((q) => ({ value: q, label: q }))]}
            onChange={(v) => onChange({ quarter: v === ALL ? null : v })}
            width={220}
          />
        </Row>
      );
      break;
    }
    case "workload": {
      const c = widget.config as WidgetConfigMap["workload"];
      const people = fields.filter((f) => f.type === "user");
      body = (
        <>
          <Row label="Unit">
            <Segmented
              label="Unit"
              value={c.unit}
              options={[
                { value: "points", label: "Points" },
                { value: "hours", label: "Hours" },
              ]}
              onChange={(unit) => onChange({ ...c, unit })}
            />
          </Row>
          <Row label="Sprint">
            <Select label="Sprint" hideLabel value={c.sprintId ?? ACTIVE} options={sprintOptions} onChange={(v) => onChange({ ...c, sprintId: v === ACTIVE ? null : v })} width={220} />
          </Row>
          <Row label="Person">
            <Select
              label="Person"
              hideLabel
              value={c.personField ?? ASSIGNEE}
              options={[{ value: ASSIGNEE, label: "Assignee" }, ...people.map((f) => ({ value: f.id, label: f.name }))]}
              onChange={(v) => onChange({ ...c, personField: v === ASSIGNEE ? null : v })}
              width={220}
            />
          </Row>
        </>
      );
      break;
    }
    case "velocity": {
      const c = widget.config;
      body = (
        <Row label="Range">
          <Segmented
            label="Range"
            value={c.range}
            options={[
              { value: "last2", label: "Last 2 sprints" },
              { value: "last6", label: "Last 6 sprints" },
            ]}
            onChange={(range) => onChange({ range })}
          />
        </Row>
      );
      break;
    }
    case "activity":
      return null;
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${name} settings`}
          className="inline-flex size-6 flex-none items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg max-[1023px]:size-8"
        >
          <Settings2 size={13} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label={`${name} settings`}
          className="z-[70] flex w-[260px] flex-col gap-3 rounded-[10px] border border-line-2 bg-raised p-3 shadow-pop outline-none data-[state=open]:animate-[menu-in_150ms_var(--ease)]"
        >
          <span className="text-[12.5px] font-semibold">{name}</span>
          {body}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
