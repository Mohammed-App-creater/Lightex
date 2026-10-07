"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRef } from "react";
import { useForm, type FieldValues, type Path, type Resolver, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import { errorMessage, isApiError } from "@/lib/api/errors";

/**
 * Board 21 §2.6 validation timing: an error shows on blur only when the field has a value
 * (the field is then "touched" and re-validates as you type), or after a submit attempt.
 * On submit, RHF focuses the first invalid field.
 */
export function useAuthForm<T extends FieldValues>(
  schema: z.ZodType<T>,
  defaultValues: T,
  opts: { deps?: Partial<Record<Path<T>, Path<T>[]>>; onAnyChange?: () => void } = {},
) {
  const form = useForm<T>({
    // zod's input/output generics don't line up with RHF's single T; the schema is the source of truth.
    resolver: zodResolver(schema as never) as unknown as Resolver<T>,
    defaultValues: defaultValues as never,
    mode: "onSubmit",
    reValidateMode: "onChange",
    shouldFocusError: true,
  });
  const touched = useRef(new Set<string>());

  const field = (name: Path<T>) =>
    form.register(name, {
      onBlur: (e: { target: HTMLInputElement }) => {
        const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
        if (v) {
          touched.current.add(name);
          void form.trigger(name);
        }
      },
      onChange: () => {
        opts.onAnyChange?.();
        const submitted = form.formState.isSubmitted;
        const names = [name, ...(opts.deps?.[name] ?? [])].filter(
          (n) => touched.current.has(n) || (submitted && n !== name && form.getValues(n)),
        );
        if (!submitted && names.length) void form.trigger(names);
        else if (submitted && names.length > 1) void form.trigger(names.slice(1));
      },
    });

  return { form, field };
}

/**
 * Puts 422 field errors onto matching fields (focusing the first). Returns a message for the
 * inline alert when the error isn't (fully) field-level, else null.
 */
export function applyServerErrors<T extends FieldValues>(
  err: unknown,
  form: UseFormReturn<T>,
  map: Partial<Record<string, Path<T>>>,
): string | null {
  if (isApiError(err) && err.status === 422) {
    const entries = Object.entries(err.fieldErrors).filter(([k]) => map[k]);
    entries.forEach(([k, msg], i) => form.setError(map[k]!, { type: "server", message: msg }, { shouldFocus: i === 0 }));
    if (entries.length) return null;
  }
  return errorMessage(err);
}
