"use client";

import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, ReactRenderer, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { Bold, Code, Italic, List, ListOrdered, SquareCode } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ReactNode,
} from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { RichDoc, RichNode, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

/* ─────────────────────────── Read-only renderer ─────────────────────────── */

const SAFE_HREF = /^(https?:|mailto:)/i;

/**
 * Renders Tiptap JSON to React elements. No HTML strings are ever injected, so stored content
 * can't execute script; links are limited to http(s)/mailto and open with rel=noopener.
 */
export function RichView({ doc, className, compact }: { doc: RichDoc | null | undefined; className?: string; compact?: boolean }) {
  if (!doc?.content?.length) return null;
  return <div className={cn("rich", compact && "rich-compact", className)}>{doc.content.map((n, i) => renderNode(n, i))}</div>;
}

function renderMarks(node: RichNode, key: number): ReactNode {
  let el: ReactNode = node.text ?? "";
  for (const m of node.marks ?? []) {
    if (m.type === "bold") el = <strong>{el}</strong>;
    else if (m.type === "italic") el = <em>{el}</em>;
    else if (m.type === "strike") el = <s>{el}</s>;
    else if (m.type === "underline") el = <u>{el}</u>;
    else if (m.type === "code") el = <code className="rich-icode">{el}</code>;
    else if (m.type === "link") {
      const href = String(m.attrs?.href ?? "");
      if (SAFE_HREF.test(href))
        el = (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {el}
          </a>
        );
    }
  }
  return <span key={key}>{el}</span>;
}

function renderChildren(n: RichNode) {
  return n.content?.map((c, i) => renderNode(c, i));
}

function renderNode(n: RichNode, key: number): ReactNode {
  switch (n.type) {
    case "paragraph":
      return <p key={key}>{renderChildren(n)}</p>;
    case "text":
      return renderMarks(n, key);
    case "hardBreak":
      return <br key={key} />;
    case "heading": {
      const level = Math.min(4, Math.max(3, Number(n.attrs?.level ?? 3)));
      return level === 3 ? <h3 key={key}>{renderChildren(n)}</h3> : <h4 key={key}>{renderChildren(n)}</h4>;
    }
    case "bulletList":
      return <ul key={key}>{renderChildren(n)}</ul>;
    case "orderedList":
      return <ol key={key}>{renderChildren(n)}</ol>;
    case "listItem":
      return <li key={key}>{renderChildren(n)}</li>;
    case "blockquote":
      return <blockquote key={key}>{renderChildren(n)}</blockquote>;
    case "horizontalRule":
      return <hr key={key} />;
    case "codeBlock":
      return <CodeBlockView key={key} language={String(n.attrs?.language ?? "") || "plain text"} code={(n.content ?? []).map((c) => c.text ?? "").join("")} />;
    case "mention":
      return (
        <span key={key} className="rich-mention">
          @{String(n.attrs?.label ?? n.attrs?.id ?? "")}
        </span>
      );
    default:
      return n.content ? <span key={key}>{renderChildren(n)}</span> : null;
  }
}

function CodeBlockView({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-1 mb-2.5 overflow-hidden rounded-md border border-line bg-bg">
      <div className="flex h-[30px] items-center justify-between border-b border-line pl-3 pr-1 font-mono text-[11px] font-medium text-fg-3">
        {language}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).catch(() => undefined);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="h-[22px] rounded-sm px-2 text-[12px] font-medium text-fg-2 hover:bg-hover hover:text-fg"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-5">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function richIsEmpty(doc: RichDoc | null | undefined) {
  const walk = (nodes?: RichNode[]): boolean =>
    !nodes || nodes.every((n) => (n.type === "text" ? !n.text?.trim() : n.type === "mention" ? false : n.type === "codeBlock" ? !n.content?.length : walk(n.content)));
  return walk(doc?.content);
}

export function richToText(doc: RichDoc | null | undefined): string {
  const parts: string[] = [];
  const walk = (nodes?: RichNode[]) =>
    nodes?.forEach((n) => {
      if (n.text) parts.push(n.text);
      if (n.type === "mention") parts.push(`@${String(n.attrs?.label ?? "")}`);
      walk(n.content);
      if (n.type === "paragraph") parts.push(" ");
    });
  walk(doc?.content);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/* ─────────────────────────── Mention suggestion ─────────────────────────── */

type MentionListHandle = { onKeyDown: (p: SuggestionKeyDownProps) => boolean };

const MentionList = forwardRef<MentionListHandle, SuggestionProps<User>>(function MentionList(props, ref) {
  const [index, setIndex] = useState(0);
  const items = props.items;
  const [prevItems, setPrevItems] = useState(items);
  if (items !== prevItems) {
    setPrevItems(items);
    setIndex(0);
  }
  const pick = (i: number) => {
    const u = items[i];
    if (u) props.command({ id: u.id, label: u.name });
  };
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowDown") {
        setIndex((i) => (i + 1) % Math.max(1, items.length));
        return true;
      }
      if (event.key === "ArrowUp") {
        setIndex((i) => (i - 1 + items.length) % Math.max(1, items.length));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        pick(index);
        return true;
      }
      return false;
    },
  }));
  const rect = props.clientRect?.();
  if (!rect || !items.length) return null;
  return (
    <div
      role="listbox"
      aria-label="Mention"
      className="fixed z-[95] w-[220px] animate-[menu-in_150ms_var(--ease)] rounded-[10px] border border-line-2 bg-raised p-1 shadow-pop"
      style={{ left: rect.left, top: rect.top - 8, transform: "translateY(-100%)" }}
    >
      {items.map((u, i) => (
        <button
          key={u.id}
          type="button"
          role="option"
          aria-selected={i === index}
          onMouseDown={(e) => {
            e.preventDefault();
            pick(i);
          }}
          className={cn("flex h-[30px] w-full items-center gap-2.5 rounded-sm px-2 text-left text-[13px] font-medium", i === index && "bg-hover")}
        >
          <Avatar name={u.name} hue={u.hue} size={20} decorative />
          {u.name}
        </button>
      ))}
    </div>
  );
});

function mentionExtension(getPeople: () => User[]) {
  return Mention.configure({
    HTMLAttributes: { class: "rich-mention" },
    suggestion: {
      char: "@",
      items: ({ query }) =>
        getPeople()
          .filter((u) => u.name.toLowerCase().split(" ").some((part) => part.startsWith(query.toLowerCase())) || u.name.toLowerCase().startsWith(query.toLowerCase()))
          .slice(0, 6),
      render: () => {
        let renderer: ReactRenderer<MentionListHandle, SuggestionProps<User>> | null = null;
        return {
          onStart: (props) => {
            renderer = new ReactRenderer(MentionList, { props, editor: props.editor });
            document.body.appendChild(renderer.element);
          },
          onUpdate: (props) => renderer?.updateProps(props),
          onKeyDown: (props) => {
            if (props.event.key === "Escape") {
              renderer?.destroy();
              renderer?.element.remove();
              renderer = null;
              return true;
            }
            return renderer?.ref?.onKeyDown(props) ?? false;
          },
          onExit: () => {
            renderer?.destroy();
            renderer?.element.remove();
            renderer = null;
          },
        };
      },
    },
  });
}

/* ─────────────────────────── Editor ─────────────────────────── */

function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-[26px] min-w-[26px] items-center justify-center rounded-[5px] px-1.5 text-fg-2 hover:bg-hover hover:text-fg",
        active && "bg-accent-s text-fg",
      )}
    >
      {children}
    </button>
  );
}

export function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return (
    <div role="toolbar" aria-label="Formatting" className="flex gap-0.5 border-b border-line px-1.5 py-1">
      <ToolButton label="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={13} aria-hidden />
      </ToolButton>
      <ToolButton label="Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={13} aria-hidden />
      </ToolButton>
      <ToolButton label="Inline code" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code size={13} aria-hidden />
      </ToolButton>
      <ToolButton label="Code block" active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        <SquareCode size={13} aria-hidden />
      </ToolButton>
      <ToolButton label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List size={13} aria-hidden />
      </ToolButton>
      <ToolButton label="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered size={13} aria-hidden />
      </ToolButton>
    </div>
  );
}

export function useRichEditor({
  initial,
  placeholder,
  people,
  onSubmit,
  onCancel,
  label,
  autofocus = true,
}: {
  initial?: RichDoc | null;
  placeholder: string;
  people?: () => User[];
  onSubmit?: () => void;
  onCancel?: () => void;
  label: string;
  autofocus?: boolean;
}) {
  return useEditor({
    immediatelyRender: false,
    autofocus: autofocus ? "end" : false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [3, 4] },
        link: { openOnClick: false, protocols: ["http", "https", "mailto"], HTMLAttributes: { rel: "noopener noreferrer nofollow" } },
      }),
      Placeholder.configure({ placeholder }),
      ...(people ? [mentionExtension(people)] : []),
    ],
    content: initial ?? undefined,
    editorProps: {
      attributes: { "aria-label": label, role: "textbox", "aria-multiline": "true", class: "rich rich-editor" },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          onSubmit?.();
          return true;
        }
        if (event.key === "Escape" && onCancel) {
          // Let an open mention list handle Escape first (it returns before this).
          onCancel();
          return true;
        }
        return false;
      },
    },
  });
}

/** Description editor (board 14 §2.9): toolbar, body, Cancel Esc / Save ⌘↵. */
export function DescriptionEditor({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: RichDoc | null;
  onSave: (doc: RichDoc | null) => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const save = () => {
    const json = editor?.getJSON() as RichDoc | undefined;
    onSave(json && !richIsEmpty(json) ? json : null);
  };
  const editor = useRichEditor({ initial, placeholder: "Add a description… Type ``` for a code block", onSubmit: () => save(), onCancel, label: "Description" });
  return (
    <div className="rounded-md border border-accent bg-surface shadow-[0_0_0_3px_var(--accent-s)]">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className="px-3 py-2.5" />
      <div className="flex justify-end gap-1.5 border-t border-line p-1.5">
        <Button size="sm" variant="ghost" kbd="Esc" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" kbd="⌘↵" loading={saving} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

/** Comment composer with @mentions; ⌘/Ctrl+Enter sends. */
export function CommentComposer({
  people,
  onSend,
  sending,
  me,
  typing,
}: {
  people: () => User[];
  /** Rejects when the comment wasn't saved, so the composer can restore the draft. */
  onSend: (doc: RichDoc) => Promise<unknown> | void;
  sending?: boolean;
  me: Pick<User, "name" | "hue">;
  /** Board 33: the typing signal (keys, blur, send) for "Sam is typing" in other people's panels. */
  typing?: { onKeyDown: (e: { key: string; metaKey?: boolean; ctrlKey?: boolean }) => void; onBlur: () => void; onSend: () => void };
}) {
  const [empty, setEmpty] = useState(true);
  const send = async () => {
    if (!editor) return;
    const json = editor.getJSON() as RichDoc;
    if (richIsEmpty(json)) return;
    if (richToText(json).length > 2000) return;
    if (sending) return;
    typing?.onSend();
    // Clear at once (the comment shows optimistically); if the send fails, put the draft back.
    editor.commands.clearContent(true);
    try {
      await onSend(json);
    } catch {
      if (!editor.isDestroyed && richIsEmpty(editor.getJSON() as RichDoc)) editor.commands.setContent(json, { emitUpdate: true });
    }
  };
  const editor = useRichEditor({ placeholder: "Comment… @ to mention", people, onSubmit: () => void send(), label: "Write a comment", autofocus: false });
  useEffect(() => {
    if (!editor) return;
    const update = () => setEmpty(richIsEmpty(editor.getJSON() as RichDoc));
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor]);
  return (
    <div className="flex items-start gap-2.5 pt-2">
      <Avatar name={me.name} hue={me.hue} size={28} decorative />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5" onKeyDown={typing ? (e) => typing.onKeyDown(e) : undefined} onBlur={typing ? () => typing.onBlur() : undefined}>
        <EditorContent
          editor={editor}
          className="min-h-10 rounded-md border border-line-2 bg-surface px-3 py-2 text-[13px] leading-5 [&_.rich-editor]:min-h-6 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-s)]"
        />
        <div className="flex justify-end">
          <Button size="sm" variant="primary" kbd="⌘↵" disabledReason={empty ? "Write something first" : undefined} loading={sending} onClick={() => void send()}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

export { EditorContent };
