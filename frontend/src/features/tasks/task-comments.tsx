"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent } from "@tiptap/react";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { useProjectMembers } from "@/features/projects/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Comment, PresencePerson, RichDoc, TaskDetail, User } from "@/lib/api/types";
import { can } from "@/lib/permissions/can";
import { ago, agoOrDate } from "@/lib/utils/dates";
import { activityText } from "./activity-text";
import { CommentComposer, RichView, richIsEmpty, useRichEditor } from "./rich-text";
import { TypingIndicator } from "@/features/presence/presence-ui";
import { useTypingSignal } from "@/features/presence/use-typing";
import { useIsLive } from "@/lib/realtime/status-store";

const NO_TYPISTS: readonly PresencePerson[] = [];

type Presence = {
  /** "Sam is typing" (others only). */
  typingLabel?: string;
  typingPeople?: readonly PresencePerson[];
  onTyping?: (typing: boolean) => void;
  /** The composer is on screen (the mock teammate simulator types only then). */
  onComposer?: (visible: boolean) => void;
};

export function TaskConversation({ task, deleted, ...presence }: { task: TaskDetail; deleted: boolean } & Presence) {
  const [tab, setTab] = useState<"comments" | "activity">("comments");
  const { data: comments = [], isPending } = useQuery({ queryKey: qk.comments(task.id), queryFn: () => api.comments.list(task.id) });
  const idBase = `conv-${task.id}`;
  return (
    <section aria-label="Comments and activity">
      <Tabs
        idBase={idBase}
        label="Comments and activity"
        value={tab}
        onChange={setTab}
        className="mb-3"
        items={[
          { value: "comments", label: "Comments", count: comments.length },
          { value: "activity", label: "Activity" },
        ]}
      />
      <TabPanel idBase={idBase} value={tab}>
        {tab === "comments" ? <Comments task={task} comments={comments} loading={isPending} deleted={deleted} {...presence} /> : <Activity task={task} />}
      </TabPanel>
    </section>
  );
}

function Comments({
  task,
  comments,
  loading,
  deleted,
  typingLabel = "",
  typingPeople = NO_TYPISTS,
  onTyping,
  onComposer,
}: { task: TaskDetail; comments: Comment[]; loading: boolean; deleted: boolean } & Presence) {
  const qc = useQueryClient();
  // Board 33: my typing goes into the panel's presence; others' typing shows under the thread (live only).
  const live = useIsLive();
  const signal = useTypingSignal();
  useEffect(() => onTyping?.(signal.typing), [signal.typing, onTyping]);
  const me = useMe();
  const { data: members = [] } = useProjectMembers(task.projectId);
  const perms = task.project.my_permissions;
  const canComment = can("comment.create", perms) && !deleted;
  const people = () => members.map((m) => m.user);
  const userById = new Map<string, User>(members.map((m) => [m.userId, m.user]));
  useEffect(() => {
    onComposer?.(canComment);
    return () => onComposer?.(false);
  }, [canComment, onComposer]);

  const send = useMutation({
    mutationFn: (body: RichDoc) => api.comments.create(task.id, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: qk.comments(task.id) });
      const prev = qc.getQueryData<Comment[]>(qk.comments(task.id));
      const temp: Comment = { id: `temp-${Date.now()}`, taskId: task.id, authorId: me.id, body, mentions: [], createdAt: new Date().toISOString(), editedAt: null };
      qc.setQueryData<Comment[]>(qk.comments(task.id), (l) => [...(l ?? []), temp]);
      return { prev, tempId: temp.id };
    },
    onError: (e, _b, ctx) => {
      qc.setQueryData(qk.comments(task.id), ctx?.prev);
      toast.error("Couldn’t post your comment", { body: `${errorMessage(e)} It’s back in the box.` });
    },
    onSuccess: (c, _b, ctx) => qc.setQueryData<Comment[]>(qk.comments(task.id), (l) => l?.map((x) => (x.id === ctx?.tempId ? c : x))),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.taskActivity(task.id) });
      void qc.invalidateQueries({ queryKey: qk.scope(task.projectId) });
    },
  });

  return (
    <div className="flex flex-col">
      {loading ? (
        <div className="flex gap-3 py-2">
          <Skeleton className="size-7 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-2.5 w-3/4" />
          </div>
        </div>
      ) : comments.length === 0 ? (
        <p className="m-0 mb-1.5 text-[12px] text-fg-3">No comments yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {comments.map((c) => (
            <CommentItem key={c.id} task={task} comment={c} author={userById.get(c.authorId)} meId={me.id} people={people} deleted={deleted} />
          ))}
        </ul>
      )}
      {live && <TypingIndicator people={typingPeople} label={typingLabel} />}
      {canComment && (
        <CommentComposer
          people={people}
          me={me}
          sending={send.isPending}
          onSend={(doc) => send.mutateAsync(doc)}
          typing={signal}
        />
      )}
    </div>
  );
}

function CommentItem({
  task,
  comment,
  author,
  meId,
  people,
  deleted,
}: {
  task: TaskDetail;
  comment: Comment;
  author: User | undefined;
  meId: string;
  people: () => User[];
  deleted: boolean;
}) {
  const qc = useQueryClient();
  const perms = task.project.my_permissions;
  const own = comment.authorId === meId;
  const canEdit = own && can("comment.edit_own", perms) && !deleted;
  const canDelete = !deleted && ((own && can("comment.edit_own", perms)) || can("comment.delete_any", perms));
  const [editing, setEditing] = useState(false);
  const pending = comment.id.startsWith("temp-");

  const remove = useMutation({
    mutationFn: () => api.comments.remove(comment.id),
    onMutate: async () => {
      const prev = qc.getQueryData<Comment[]>(qk.comments(task.id));
      qc.setQueryData<Comment[]>(qk.comments(task.id), (l) => l?.filter((x) => x.id !== comment.id));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(qk.comments(task.id), ctx?.prev);
      toast.error("Couldn’t delete the comment", { body: errorMessage(e) });
    },
  });
  const update = useMutation({
    mutationFn: (body: RichDoc) => api.comments.update(comment.id, body),
    onMutate: async (body) => {
      const prev = qc.getQueryData<Comment[]>(qk.comments(task.id));
      qc.setQueryData<Comment[]>(qk.comments(task.id), (l) => l?.map((x) => (x.id === comment.id ? { ...x, body, editedAt: new Date().toISOString() } : x)));
      setEditing(false);
      return { prev };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(qk.comments(task.id), ctx?.prev);
      toast.error("Couldn’t save the comment", { body: errorMessage(e) });
    },
  });

  return (
    <li className="group/cmt flex gap-3 py-2" aria-busy={pending || undefined}>
      <Avatar name={author?.name ?? "Unknown"} hue={author?.hue} size={28} decorative />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{author?.name ?? "Former member"}</span>
          <span className="text-[11px] text-fg-3">
            {pending ? "sending…" : ago(comment.createdAt)}
            {comment.editedAt && " · edited"}
          </span>
          {(canEdit || canDelete) && !pending && (
            <Menu>
              <MenuTrigger asChild>
                <button type="button" aria-label="Comment actions" className="ml-auto flex size-6 items-center justify-center rounded-sm text-fg-3 opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/cmt:opacity-100 data-[state=open]:opacity-100 max-[1023px]:opacity-100">
                  <MoreHorizontal size={14} aria-hidden />
                </button>
              </MenuTrigger>
              <MenuContent align="end" width={160}>
                {canEdit && <MenuItem onSelect={() => setEditing(true)}>Edit</MenuItem>}
                {canDelete && (
                  <MenuItem danger onSelect={() => remove.mutate()}>
                    Delete
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          )}
        </div>
        {editing ? (
          <CommentEditForm initial={comment.body} people={people} onCancel={() => setEditing(false)} onSave={(b) => update.mutate(b)} />
        ) : (
          <RichView doc={comment.body} compact />
        )}
      </div>
    </li>
  );
}

function CommentEditForm({ initial, people, onCancel, onSave }: { initial: RichDoc; people: () => User[]; onCancel: () => void; onSave: (d: RichDoc) => void }) {
  const save = () => {
    const doc = editor?.getJSON() as RichDoc | undefined;
    if (doc && !richIsEmpty(doc)) onSave(doc);
  };
  const editor = useRichEditor({ initial, placeholder: "Edit comment…", people, onSubmit: () => save(), onCancel, label: "Edit comment" });
  return (
    <div className="flex flex-col gap-1.5">
      <EditorContent editor={editor} className="rounded-md border border-accent bg-surface px-3 py-2 shadow-[0_0_0_3px_var(--accent-s)] [&_.rich-editor]:min-h-6" />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" kbd="Esc" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" kbd="⌘↵" onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

function Activity({ task }: { task: TaskDetail }) {
  const { data = [], isPending } = useQuery({ queryKey: qk.taskActivity(task.id), queryFn: () => api.tasks.activity(task.id) });
  const { data: members = [] } = useProjectMembers(task.projectId);
  if (isPending) return <Skeleton className="h-16 w-full" />;
  if (!data.length) return <p className="m-0 text-[12px] text-fg-3">No activity yet.</p>;
  return (
    <ol className="relative m-0 flex list-none flex-col gap-3 p-0 pl-[22px] before:absolute before:bottom-1.5 before:left-1.5 before:top-1.5 before:w-px before:bg-line-2 before:content-['']">
      {data.map((a) => {
        const actor = members.find((m) => m.userId === a.actorId)?.user;
        return (
          <li
            key={a.id}
            className="relative text-[13px] leading-5 text-fg-2 before:absolute before:-left-5 before:top-1.5 before:size-[9px] before:rounded-full before:border-[1.5px] before:border-control before:bg-surface before:content-['']"
          >
            <b className="font-medium text-fg">{actor?.name ?? "Lightex"}</b> {activityText(a)}
            <span className="text-[11px] text-fg-3"> · {agoOrDate(a.createdAt)}</span>
          </li>
        );
      })}
    </ol>
  );
}
