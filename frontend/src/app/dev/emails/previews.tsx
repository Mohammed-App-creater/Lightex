"use client";

import { useState } from "react";
import { Segmented } from "@/components/ui/choice";
import { EmptyState } from "@/components/ui/feedback";
import { cn } from "@/lib/utils/cn";
import { EMAIL_TEMPLATES, mergeTags, renderTemplate } from "./catalog";

type Mode = "light" | "dark";

/**
 * Dark preview: the templates' `@media (prefers-color-scheme: dark)` follows the OS, which a page
 * can't force inside a frame, so the preview sets the [data-ogsb]/[data-ogsc] attributes that the
 * same templates honour for Outlook.com dark mode.
 */
function withMode(html: string, mode: Mode) {
  return mode === "dark" ? html.replace(/<html\b/i, "<html data-ogsb data-ogsc") : html;
}

export function EmailPreviews({ sources }: { sources: { id: string; html: string | null }[] }) {
  const [active, setActive] = useState(EMAIL_TEMPLATES[0]!.id);
  const [mode, setMode] = useState<Mode>("light");
  const tpl = EMAIL_TEMPLATES.find((t) => t.id === active)!;
  const src = sources.find((s) => s.id === active)?.html ?? null;
  const doc = src ? withMode(renderTemplate(src, tpl.sample), mode) : "";
  const subject = renderTemplate(tpl.subject, tpl.sample).replace(/&#39;/g, "’");

  return (
    <div className="mx-auto grid max-w-[1400px] grid-cols-[240px_minmax(0,1fr)] gap-8 px-8 pb-16 max-[1023px]:grid-cols-1 max-[760px]:px-4">
      <nav aria-label="Templates" className="flex flex-col gap-0.5 max-[1023px]:flex-row max-[1023px]:overflow-x-auto max-[1023px]:[scrollbar-width:none]">
        {EMAIL_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={t.id === active ? "true" : undefined}
            onClick={() => setActive(t.id)}
            className={cn(
              "flex min-h-9 flex-none flex-col items-start justify-center gap-0.5 rounded-[7px] px-2.5 py-1.5 text-left text-[13px] font-medium text-fg-2 hover:bg-hover hover:text-fg max-[760px]:min-h-11",
              t.id === active && "bg-accent-s text-fg hover:bg-accent-s",
            )}
          >
            {t.label}
            <span className="font-mono text-[11px] text-fg-3 max-[1023px]:hidden">{t.file}</span>
          </button>
        ))}
      </nav>

      <section aria-label={tpl.label} className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-wrap items-start gap-4">
          <dl className="m-0 grid min-w-0 flex-1 grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
            <dt className="text-fg-3">File</dt>
            <dd className="m-0 font-mono text-[12px]">emails/{tpl.file}</dd>
            <dt className="text-fg-3">Subject</dt>
            <dd className="m-0 font-medium">{subject}</dd>
            <dt className="text-fg-3">Trigger</dt>
            <dd className="m-0 text-fg-2">{tpl.trigger}</dd>
            {src && (
              <>
                <dt className="text-fg-3">Merge tags</dt>
                <dd className="m-0 flex flex-wrap gap-1">
                  {mergeTags(src).map((m) => (
                    <code key={m} className="rounded-xs border border-line bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg-2">
                      {m}
                    </code>
                  ))}
                </dd>
              </>
            )}
          </dl>
          <Segmented<Mode>
            label="Client colour scheme"
            value={mode}
            onChange={setMode}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </div>

        {src === null ? (
          <EmptyState illustration="error" title="Template missing" body={`emails/${tpl.file} couldn’t be read.`} />
        ) : (
          <div className="flex flex-wrap items-start gap-8">
            {[600, 375].map((w) => (
              <figure key={w} className="m-0 flex max-w-full flex-col gap-2">
                <figcaption className="font-mono text-[11px] text-fg-3">
                  {w}px · {mode}
                </figcaption>
                <iframe
                  title={`${tpl.label}, ${w}px, ${mode}`}
                  sandbox=""
                  srcDoc={doc}
                  width={w}
                  height={w === 600 ? 760 : 860}
                  className="max-w-full rounded-lg border border-line-2 bg-white"
                />
              </figure>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
