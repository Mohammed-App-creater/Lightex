"use client";

import * as Popover from "@radix-ui/react-popover";
import { Lock, Plus, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/choice";
import { Modal } from "@/components/ui/modal";
import { CF_TYPE_ICON } from "@/features/filters/filter-bar";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { CustomField, CustomFieldInput, CustomFieldType, FieldColor } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { COLOR_NAMES, FIELD_NAME_MAX, FIELD_TYPES, OPTION_NAME_MAX, PALETTE, TYPE_LABEL, fieldNameError, optionsError } from "./field-lib";

type OptDraft = { key: string; id?: string; name: string; color: FieldColor };
let seq = 0;
const newKey = () => `o${++seq}`;
const nextColor = (opts: OptDraft[]) => PALETTE[opts.length % PALETTE.length]!.token;

/**
 * Create / edit a custom field (board 39 .cf-dlg): name (40, counter), type radiogroup (locked in
 * edit mode with a visible reason), options for select (8-colour palette, Enter adds the next),
 * Required switch. Esc closes an open palette first, then the dialog.
 */
export function CustomFieldDialog({
  open,
  onOpenChange,
  field,
  fields,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit mode when set. */
  field: CustomField | null;
  fields: CustomField[];
  /** Create (no field) or update; resolves on success, throws the API error otherwise. */
  onSubmit: (body: CustomFieldInput) => Promise<unknown>;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={field ? `Edit “${field.name}”` : "New custom field"} width={440}>
      {open && <DialogBody key={field?.id ?? "new"} field={field} fields={fields} onCancel={() => onOpenChange(false)} onSubmit={onSubmit} />}
    </Modal>
  );
}

function DialogBody({ field, fields, onCancel, onSubmit }: { field: CustomField | null; fields: CustomField[]; onCancel: () => void; onSubmit: (body: CustomFieldInput) => Promise<unknown> }) {
  const editing = Boolean(field);
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<CustomFieldType>(field?.type ?? "text");
  const [required, setRequired] = useState(field?.required ?? false);
  const [options, setOptions] = useState<OptDraft[]>(() =>
    field?.options.length ? field.options.map((o) => ({ key: newKey(), id: o.id, name: o.name, color: o.color })) : [{ key: newKey(), name: "", color: PALETTE[0]!.token }],
  );
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<{ name?: string; options?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const optRefs = useRef(new Map<string, HTMLInputElement>());
  const typeRefs = useRef(new Map<CustomFieldType, HTMLButtonElement>());

  const nameErr = server.name ?? (tried ? fieldNameError(name, fields, field?.id) : null);
  const optErr = type === "select" ? (server.options ?? (tried ? optionsError(options) : null)) : null;

  const addOption = (after?: string) => {
    const o: OptDraft = { key: newKey(), name: "", color: nextColor(options) };
    setOptions((l) => {
      const i = after ? l.findIndex((x) => x.key === after) : l.length - 1;
      return [...l.slice(0, i + 1), o, ...l.slice(i + 1)];
    });
    requestAnimationFrame(() => optRefs.current.get(o.key)?.focus());
  };

  const onTypeKey = (e: KeyboardEvent) => {
    if (editing) return;
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = FIELD_TYPES[(FIELD_TYPES.indexOf(type) + step + FIELD_TYPES.length) % FIELD_TYPES.length]!;
    setType(next);
    typeRefs.current.get(next)?.focus();
  };

  const submit = async () => {
    setTried(true);
    setServer({});
    if (fieldNameError(name, fields, field?.id) || (type === "select" && optionsError(options)) || busy) return;
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        type,
        required,
        options: type === "select" ? options.filter((o) => o.name.trim()).map((o) => ({ ...(o.id ? { id: o.id } : {}), name: o.name.trim(), color: o.color })) : undefined,
      });
    } catch (e) {
      const f = isApiError(e) ? e.fieldErrors : {};
      const optionMsg = Object.entries(f).find(([k]) => k.startsWith("options"))?.[1];
      setServer({ name: f.name, options: optionMsg, form: f.name || optionMsg ? undefined : errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="cf-name" className="text-[12px] font-medium text-fg-2">
            Name
          </label>
          <span className="font-mono text-[11px] text-fg-3" aria-hidden>
            {name.length}/{FIELD_NAME_MAX}
          </span>
        </div>
        <input
          id="cf-name"
          autoFocus
          maxLength={FIELD_NAME_MAX}
          value={name}
          placeholder="e.g. Browser"
          aria-invalid={nameErr ? true : undefined}
          aria-describedby="cf-name-help"
          onChange={(e) => {
            setName(e.target.value);
            setServer((s) => ({ ...s, name: undefined }));
          }}
          className={cn(
            "h-[34px] w-full rounded-sm border border-control bg-surface px-2.5 text-[13px] text-fg outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] placeholder:text-fg-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--ring)] max-[760px]:h-11 max-[760px]:text-[15px]",
            nameErr && "border-danger",
          )}
        />
        <span id="cf-name-help" role={nameErr ? "alert" : undefined} className={cn("min-h-4 text-[12px] leading-4", nameErr ? "text-danger" : "text-fg-3")}>
          {nameErr ?? ""}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span id="cf-type-l" className="text-[12px] font-medium text-fg-2">
          Type
        </span>
        <div role="radiogroup" aria-labelledby="cf-type-l" aria-disabled={editing || undefined} aria-describedby={editing ? "cf-type-lock" : undefined} onKeyDown={onTypeKey} className="grid grid-cols-5 gap-1.5 max-[760px]:grid-cols-3">
          {FIELD_TYPES.map((t) => {
            const on = t === type;
            return (
              <button
                key={t}
                ref={(el) => {
                  if (el) typeRefs.current.set(t, el);
                }}
                type="button"
                role="radio"
                aria-checked={on}
                aria-disabled={editing || undefined}
                tabIndex={on ? 0 : -1}
                onClick={() => !editing && setType(t)}
                className={cn(
                  "flex h-[58px] flex-col items-center justify-center gap-1.5 rounded-md border border-line-2 bg-bg text-[11.5px] font-medium text-fg-2 transition-colors duration-[var(--dur-fast)] [&_svg]:size-3.5",
                  !editing && "hover:border-control hover:text-fg",
                  on && "border-accent bg-accent-s text-fg [&_svg]:text-accent-t",
                  editing && !on && "opacity-50",
                  editing && "cursor-not-allowed",
                )}
              >
                {CF_TYPE_ICON[t]}
                {TYPE_LABEL[t]}
              </button>
            );
          })}
        </div>
        {editing && (
          <span id="cf-type-lock" className="flex items-center gap-1.5 text-[12px] text-fg-3">
            <Lock size={11} aria-hidden /> A field’s type can’t be changed
          </span>
        )}
      </div>

      {type === "select" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2">Options</span>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {options.map((o, i) => (
              <li key={o.key} className="flex items-center gap-2">
                <Swatch value={o.color} label={`Colour for ${o.name || `option ${i + 1}`}`} onChange={(color) => setOptions((l) => l.map((x) => (x.key === o.key ? { ...x, color } : x)))} />
                <input
                  ref={(el) => {
                    if (el) optRefs.current.set(o.key, el);
                    else optRefs.current.delete(o.key);
                  }}
                  value={o.name}
                  maxLength={OPTION_NAME_MAX}
                  placeholder={`Option ${i + 1}`}
                  aria-label={`Option ${i + 1}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    setOptions((l) => l.map((x) => (x.key === o.key ? { ...x, name: v } : x)));
                    setServer((s) => ({ ...s, options: undefined }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addOption(o.key);
                    }
                  }}
                  className="h-[30px] min-w-0 flex-1 rounded-sm border border-control bg-surface px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--ring)] max-[760px]:h-11"
                />
                {options.length > 1 && (
                  <Button
                    variant="ghost"
                    icon
                    size="sm"
                    aria-label={`Remove ${o.name || `option ${i + 1}`}`}
                    onClick={() => setOptions((l) => l.filter((x) => x.key !== o.key))}
                    className="max-[760px]:size-11"
                  >
                    <X size={12} aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            {options.length < 50 && (
              <Button variant="ghost" size="sm" className="-ml-2" onClick={() => addOption()}>
                <Plus size={12} aria-hidden /> Add option
              </Button>
            )}
            <span role={optErr ? "alert" : undefined} className="text-[12px] text-danger">
              {optErr ?? ""}
            </span>
          </div>
          {editing && field && field.options.some((x) => !options.some((o) => o.id === x.id)) && (
            <p className="m-0 rounded-md border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-3 py-2 text-[12.5px] leading-[18px]">
              Removed options are cleared from the tasks that use them.
            </p>
          )}
        </div>
      )}

      <label className="flex cursor-pointer items-center justify-between gap-2.5 rounded-md border border-line bg-bg px-3 py-2.5">
        <span>
          <span className="block text-[13px] font-medium">Required</span>
          <small className="mt-[3px] block text-[12px] text-fg-3">Always shown, flagged when empty</small>
        </span>
        <Switch checked={required} onChange={(e) => setRequired(e.target.checked)} aria-label="Required" />
      </label>

      {server.form && (
        <p role="alert" className="m-0 text-[12px] text-danger">
          {server.form}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" loading={busy} kbd="↵">
          {editing ? "Save" : "Create field"}
        </Button>
      </div>
    </form>
  );
}

/** Option colour swatch with the 8-colour palette (4 × 2 radiogroup, arrow keys). */
function Swatch({ value, label, onChange }: { value: FieldColor; label: string; onChange: (c: FieldColor) => void }) {
  const [open, setOpen] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const items = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 4 : e.key === "ArrowUp" ? -4 : 0;
    if (i < 0 || !step) return;
    e.preventDefault();
    items[(i + step + items.length) % items.length]?.focus();
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={`${label}: ${COLOR_NAMES[value]}`} className="flex size-7 flex-none items-center justify-center rounded-sm border border-line-2 bg-bg hover:border-control max-[760px]:size-11">
          <span aria-hidden className="size-2.5 rounded-full" style={{ background: value }} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            grid.current?.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
          }}
          className="z-[70] rounded-[10px] border border-line-2 bg-raised p-1.5 shadow-pop outline-none data-[state=open]:animate-[menu-in_150ms_var(--ease)]"
        >
          <div ref={grid} role="radiogroup" aria-label={label} onKeyDown={onKey} className="grid grid-cols-[repeat(4,28px)] gap-1 max-[760px]:grid-cols-[repeat(4,40px)]">
            {PALETTE.map((c) => {
              const on = c.token === value;
              return (
                <button
                  key={c.token}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={c.name}
                  tabIndex={on ? 0 : -1}
                  onClick={() => {
                    onChange(c.token);
                    setOpen(false);
                  }}
                  className="flex size-7 items-center justify-center rounded-sm hover:bg-hover aria-checked:bg-hover max-[760px]:size-10"
                  style={{ color: c.token }}
                >
                  <span aria-hidden className={cn("size-3 rounded-full bg-current", on && "shadow-[0_0_0_2px_var(--raised),0_0_0_3.5px_currentColor]")} />
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
