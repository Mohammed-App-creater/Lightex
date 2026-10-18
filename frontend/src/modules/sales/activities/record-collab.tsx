"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Paperclip, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "@/api/endpoints";
import { errorMessage, isNotFound } from "@/api/errors";
import { qk } from "@/api/query-keys";
import { uploadAttachment } from "@/api/uploads";
import type { Attachment, Comment, RichDoc, RichNode, TargetRef } from "@/api/types";
import { useSession } from "@/platform/auth/session";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/card";
import { Skeleton } from "@/ui/feedback";
import { Textarea } from "@/ui/input";
import { toast } from "@/ui/toast";
import { ACCEPT_ATTR, formatBytes } from "@/lib/files";
import { agoOrDate } from "@/lib/utils/dates";
import { useSalesPeople } from "../shared/user-picker";

/*
 * Comments and attachments on a sales record (`targets/{sales.company|sales.opportunity|…}/{id}`, api.md §8), on the
 * platform's generic collab routes. Comments are plain paragraphs here (Tiptap JSON on the wire, rendered as text,
 * never HTML). Shared by the company page and the opportunity / lead pages.
 */

const toDoc = (text: string): RichDoc => ({
  type: "doc",
  content: text.split(/\n{2,}/).map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
});
function docText(doc: RichDoc | null | undefined): string {
  const out: string[] = [];
  const walk = (nodes?: RichNode[]) =>
    nodes?.forEach((n) => {
      if (n.text) out.push(n.text);
      if (n.type === "mention") out.push(`@${String(n.attrs?.label ?? "")}`);
      walk(n.content);
      if (n.type === "paragraph") out.push("\n");
    });
  walk(doc?.content);
  return out.join("").trim();
}

export function RecordCollab({ target, canComment = true }: { target: TargetRef; canComment?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <RecordComments target={target} canComment={canComment} />
      <RecordAttachments target={target} canUpload={canComment} />
    </div>
  );
}

export function RecordComments({ target, canComment = true }: { target: TargetRef; canComment?: boolean }) {
  const qc = useQueryClient();
  const { user } = useSession();
  const { people } = useSalesPeople();
  const key = qk.comments(target.targetId);
  const q = useQuery({ queryKey: key, queryFn: () => api.comments.list(target), retry: false });
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: (body: RichDoc) => api.comments.create(target, body),
    onSuccess: (c) => {
      qc.setQueryData<Comment[]>(key, (l) => [...(l ?? []), c]);
      setText("");
    },
    onError: (e) => toast.error("Couldn’t post your comment", { body: errorMessage(e) }),
  });
  const unavailable = q.isError && isNotFound(q.error);
  const comments = q.data ?? [];
  return (
    <Panel title={`Comments${comments.length ? ` · ${comments.length}` : ""}`}>
      {q.isPending ? (
        <div className="flex gap-3 py-1">
          <Skeleton className="size-7 rounded-full" />
          <Skeleton className="h-2.5 w-2/3" />
        </div>
      ) : unavailable ? (
        <p className="m-0 text-meta text-fg-3">Comments aren’t available here yet.</p>
      ) : q.isError ? (
        <p className="m-0 text-meta text-fg-3">
          Couldn’t load comments.{" "}
          <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => void q.refetch()}>
            Retry
          </button>
        </p>
      ) : comments.length === 0 ? (
        <p className="m-0 text-meta text-fg-3">No comments yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {comments.map((c) => {
            const a = people.find((p) => p.id === c.authorId);
            return (
              <li key={c.id} className="flex gap-2.5">
                <Avatar name={a?.name ?? "Someone"} hue={a?.hue} size={28} decorative />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-meta">
                    <span className="font-medium text-fg">{a?.name ?? "Someone"}</span> <span className="text-fg-3">{agoOrDate(c.createdAt)}</span>
                  </span>
                  <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-5">{docText(c.body)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {canComment && !unavailable && user && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send.mutate(toDoc(text.trim()));
          }}
        >
          <Textarea aria-label="Write a comment" rows={2} maxLength={2000} placeholder="Write a comment…" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex justify-end">
            <Button type="submit" size="sm" variant="primary" loading={send.isPending} disabled={!text.trim()}>
              Comment
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

export function RecordAttachments({ target, canUpload = true }: { target: TargetRef; canUpload?: boolean }) {
  const qc = useQueryClient();
  const { user } = useSession();
  const key = qk.attachments(target.targetId);
  const q = useQuery({ queryKey: key, queryFn: () => api.attachments.list(target), retry: false });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const unavailable = q.isError && isNotFound(q.error);
  const files = q.data ?? [];

  const upload = async (list: FileList) => {
    setBusy(true);
    try {
      for (const f of Array.from(list).slice(0, 10)) {
        const att = await uploadAttachment(target, f, () => undefined);
        qc.setQueryData<Attachment[]>(key, (l) => [...(l ?? []), att]);
      }
    } catch (e) {
      toast.error("Upload failed", { body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const remove = useMutation({
    mutationFn: (a: Attachment) => api.attachments.remove(a.id),
    onSuccess: (_r, a) => qc.setQueryData<Attachment[]>(key, (l) => l?.filter((x) => x.id !== a.id)),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Panel
      title={`Files${files.length ? ` · ${files.length}` : ""}`}
      actions={
        canUpload &&
        !unavailable &&
        !q.isPending && (
          <>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => input.current?.click()}>
              <Paperclip size={14} aria-hidden /> Attach
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              accept={ACCEPT_ATTR}
              aria-label="Upload files"
              onChange={(e) => {
                if (e.target.files?.length) void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        )
      }
    >
      {q.isPending ? (
        <Skeleton className="h-8 w-full" />
      ) : unavailable ? (
        <p className="m-0 text-meta text-fg-3">Files aren’t available here yet.</p>
      ) : files.length === 0 ? (
        <p className="m-0 text-meta text-fg-3">No files. Images or code, 10 MB max.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {files.map((f) => (
            <li key={f.id} className="flex min-h-9 items-center gap-2 rounded-sm px-1 hover:bg-hover">
              <span className="min-w-0 flex-1 truncate text-[13px]">{f.fileName}</span>
              <span className="font-mono text-[11px] text-fg-3">{formatBytes(f.size)}</span>
              <Button asChild size="sm" variant="ghost" icon aria-label={`Download ${f.fileName}`}>
                <a href={f.downloadUrl} download={f.fileName} rel="noopener">
                  <Download size={14} aria-hidden />
                </a>
              </Button>
              {f.uploaderId === user?.id && (
                <Button size="sm" variant="ghost" icon aria-label={`Delete ${f.fileName}`} onClick={() => remove.mutate(f)}>
                  <Trash2 size={14} aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
