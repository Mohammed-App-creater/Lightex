"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Segmented, Switch } from "@/components/ui/choice";
import { Modal } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { FilterRule, SavedView, ViewIcon } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { FIELD_ICON } from "./filter-bar";
import { completeRules } from "./filter-model";
import type { FilterOptions } from "./use-filters";
import { VIEW_ICONS, ViewGlyph } from "./view-icons";
import { useCreateView, useViews } from "./views";

/** Save view (board 30): name · icon · filter summary · pin to sidebar · visibility. */
export function SaveViewDialog({
  open,
  onOpenChange,
  slug,
  projectId,
  layout,
  rules,
  opts,
  canShare,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  slug: string;
  projectId: string;
  layout: SavedView["layout"];
  rules: FilterRule[];
  opts: FilterOptions;
  /** Project-visible views need task.create (viewers save "Only me" views). */
  canShare: boolean;
  onSaved: (v: SavedView) => void;
}) {
  return open ? <Inner {...{ onOpenChange, slug, projectId, layout, rules, opts, canShare, onSaved }} /> : null;
}

function Inner({
  onOpenChange,
  slug,
  projectId,
  layout,
  rules,
  opts,
  canShare,
  onSaved,
}: Omit<Parameters<typeof SaveViewDialog>[0], "open">) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<ViewIcon>("filter");
  const [pin, setPin] = useState(true);
  const [vis, setVis] = useState<SavedView["visibility"]>("me");
  const [err, setErr] = useState("");
  const me = useMe();
  const { data: views = [] } = useViews(slug);
  const create = useCreateView(slug);
  const done = completeRules(rules);

  const save = async () => {
    const n = name.trim().slice(0, 40);
    if (!n) return setErr("Name is required");
    if (views.some((v) => v.ownerId === me.id && v.name.toLowerCase() === n.toLowerCase())) return setErr("A view with this name exists");
    try {
      const v = await create.mutateAsync({ projectId, name: n, icon, visibility: canShare ? vis : "me", layout, filters: done, pinned: pin });
      onOpenChange(false);
      toast.success(pin ? `${v.name} pinned to sidebar` : `${v.name} saved`);
      onSaved(v);
    } catch (e) {
      if (isApiError(e) && e.fieldErrors.name) setErr(e.fieldErrors.name);
      else toast.error("Couldn’t save the view", { body: errorMessage(e) });
    }
  };

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title="Save view"
      footer={
        <>
          <Button variant="ghost" kbd="Esc" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" kbd="↵" loading={create.isPending} onClick={() => void save()}>
            Save view
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div
            className={cn(
              "flex h-[38px] items-center gap-2 rounded-md border border-line-2 bg-bg px-2.5 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-s)]",
              err && "border-danger",
            )}
          >
            <span className="text-accent-t">
              <ViewGlyph icon={icon} size={15} />
            </span>
            <input
              autoFocus
              aria-label="View name"
              aria-invalid={Boolean(err)}
              aria-describedby={err ? "save-view-err" : undefined}
              placeholder="View name"
              maxLength={40}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErr("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
              className="h-full min-w-0 flex-1 bg-transparent focus-visible:!shadow-none text-[14px] font-medium text-fg outline-none placeholder:font-normal placeholder:text-fg-3"
            />
          </div>
          {err && (
            <span id="save-view-err" role="alert" className="text-[12px] text-danger">
              {err}
            </span>
          )}
        </div>
        <div role="radiogroup" aria-label="Icon" className="flex gap-1.5">
          {VIEW_ICONS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={icon === v.id}
              aria-label={v.name}
              onClick={() => setIcon(v.id)}
              className="flex size-[34px] items-center justify-center rounded-md border border-line-2 bg-raised text-fg-2 transition-[border-color,background-color,color,transform] duration-150 [transition-timing-function:var(--spring)] hover:border-control hover:text-fg aria-checked:scale-[1.04] aria-checked:border-accent aria-checked:bg-accent-s aria-checked:text-accent-t max-[760px]:size-11"
            >
              <v.Icon size={15} strokeWidth={1.6} aria-hidden />
            </button>
          ))}
        </div>
        <ul aria-label="Filters in this view" className="m-0 flex list-none flex-wrap gap-[5px] p-0">
          {done.map((r, i) => (
            <li key={i} className="inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-[5px] border border-line bg-raised px-[7px] text-[11.5px] text-fg-2 [&_svg]:size-[11px]">
              {FIELD_ICON[r.field]}
              {opts.describe(r)}
            </li>
          ))}
        </ul>
        <Switch label={<span className="font-medium">Pin to sidebar</span>} checked={pin} onChange={(e) => setPin(e.target.checked)} />
        {canShare && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-ui font-medium">Visible to</span>
            <Segmented
              label="Visible to"
              value={vis}
              onChange={setVis}
              options={[
                { value: "me", label: "Only me" },
                { value: "project", label: "Project" },
              ]}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
