import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { devToolsEnabled } from "@/lib/env";
import { Gallery } from "./gallery";

export const metadata: Metadata = { title: "UI gallery" };

/** Dev-only component gallery: every base component in all three themes, side by side. */
export default function DevUiPage() {
  if (!devToolsEnabled) notFound();
  const themes = [
    { id: "dark", name: "Deep navy (default)" },
    { id: "black", name: "Near-black" },
    { id: "light", name: "Light" },
  ];
  return (
    <main className="min-h-dvh bg-bg">
      <header className="mx-auto flex max-w-[1800px] flex-col gap-2 px-8 pb-6 pt-12">
        <span className="font-mono text-meta tracking-[0.04em] text-fg-2">DESIGN SYSTEM · DEV</span>
        <h1 className="m-0 text-display">Component gallery</h1>
        <p className="m-0 text-fg-2">Rendered from the same components and tokens the app uses.</p>
      </header>
      <div className="mx-auto grid max-w-[1800px] gap-6 px-8 pb-16 max-[760px]:px-4 xl:grid-cols-3 [&>*]:min-w-0">
        {themes.map((t) => (
          <div key={t.id} data-theme={t.id} className="flex flex-col gap-4 rounded-xl border border-line-2 bg-bg p-5 text-fg">
            <h2 className="m-0 font-mono text-caption uppercase text-fg-3">{t.name}</h2>
            <Gallery scope={t.id} />
          </div>
        ))}
      </div>
    </main>
  );
}
