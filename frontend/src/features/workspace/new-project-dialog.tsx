"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/choice";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { ProjectTemplate } from "@/lib/api/types";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";

/** Same derivation as onboarding: one word → first 3 letters, several → initials of up to 4. */
export function deriveKey(name: string) {
  const words = name.toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1) return words[0]!.slice(0, 3);
  return words.slice(0, 4).map((w) => w[0]).join("");
}

const schema = z.object({
  name: z.string().trim().min(2, "Name the project (2+ characters)").max(60),
  key: z.string().regex(/^[A-Z]{2,5}$/, "Key: 2–5 letters"),
  description: z.string().max(500),
});

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const qc = useQueryClient();
  const [keyTouched, setKeyTouched] = useState(false);
  const [template, setTemplate] = useState<ProjectTemplate>("kanban");
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: "", key: "", description: "" } });
  const create = useMutation({
    mutationFn: (v: z.infer<typeof schema>) => api.projects.create(ws.slug, { ...v, template }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.projects(ws.slug) });
      onOpenChange(false);
      form.reset();
      toast({ tone: "spark", title: `${p.name} created`, body: "Set it up from the overview." });
      router.push(routes.project(ws.slug, p.key));
    },
    onError: (e) => {
      if (isApiError(e) && Object.keys(e.fieldErrors).length) {
        Object.entries(e.fieldErrors).forEach(([k, m]) => form.setError(k as "name" | "key", { message: m }));
      } else toast.error("Couldn’t create the project", { body: errorMessage(e) });
    },
  });
  const nameReg = form.register("name");
  const keyReg = form.register("key");
  const keyPreview = useWatch({ control: form.control, name: "key" });
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="New project" description={`In ${ws.name}. You’ll be its Project Admin.`} width={480}>
      <form className="flex flex-col gap-4" noValidate onSubmit={form.handleSubmit((v) => create.mutate(v))}>
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field label="Project name" error={form.formState.errors.name?.message}>
            <Input
              autoFocus
              placeholder="Platform Rebuild"
              maxLength={60}
              {...nameReg}
              onChange={(e) => {
                void nameReg.onChange(e);
                if (!keyTouched) form.setValue("key", deriveKey(e.target.value).slice(0, 5));
              }}
            />
          </Field>
          <Field label="Key" error={form.formState.errors.key?.message}>
            <Input
              mono
              placeholder="PRJ"
              maxLength={5}
              className="uppercase tracking-[0.04em]"
              {...keyReg}
              onChange={(e) => {
                setKeyTouched(true);
                e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "");
                void keyReg.onChange(e);
              }}
            />
          </Field>
        </div>
        <p className="-mt-2 m-0 font-mono text-meta text-fg-3">Tasks: {keyPreview || "KEY"}-1, {keyPreview || "KEY"}-2…</p>
        <Field label="Description" hint="Optional">
          <Textarea maxLength={500} className="min-h-16" {...form.register("description")} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-meta font-medium text-fg-2">Template</span>
          <Segmented
            label="Template"
            value={template}
            onChange={setTemplate}
            options={[
              { value: "kanban", label: "Kanban" },
              { value: "scrum", label: "Scrum" },
              { value: "bugs", label: "Bug tracking" },
            ]}
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" kbd="Esc" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" kbd="↵" loading={create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  );
}
