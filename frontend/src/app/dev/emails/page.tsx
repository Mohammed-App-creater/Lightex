import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { devToolsEnabled } from "@/lib/env";
import { EMAIL_TEMPLATES } from "./catalog";
import { EmailPreviews } from "./previews";

export const metadata: Metadata = { title: "Email templates" };

/** Dev-only preview of emails/*.html (board 36) with sample data, gated like /dev/ui. */
export default async function DevEmailsPage() {
  if (!devToolsEnabled) notFound();
  const sources = await Promise.all(
    EMAIL_TEMPLATES.map(async (t) => {
      try {
        return { id: t.id, html: await readFile(join(process.cwd(), "emails", t.file), "utf8") };
      } catch {
        return { id: t.id, html: null };
      }
    }),
  );
  return (
    <main className="min-h-dvh bg-bg text-fg">
      <header className="mx-auto flex max-w-[1400px] flex-col gap-2 px-8 pb-6 pt-12 max-[760px]:px-4">
        <span className="font-mono text-meta tracking-[0.04em] text-fg-2">TEMPLATES · EMAIL · DEV</span>
        <h1 className="m-0 text-display">Emails</h1>
        <p className="m-0 max-w-[640px] text-fg-2">
          The {EMAIL_TEMPLATES.length} templates in <code className="font-mono">emails/</code>, merged with sample data and rendered in
          sandboxed frames at 600 and 375. Dark previews use the Outlook.com dark-mode hooks the templates ship with.
        </p>
      </header>
      <EmailPreviews sources={sources} />
    </main>
  );
}
