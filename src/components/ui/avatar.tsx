import { UserRound } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export type AvatarSize = 18 | 20 | 24 | 28 | 30 | 32 | 36 | 40;

const fontFor: Record<AvatarSize, string> = {
  18: "text-[8px]",
  20: "text-[9px]",
  24: "text-[10px]",
  28: "text-[11px]",
  30: "text-[11px]",
  32: "text-[12px]",
  36: "text-[13px]",
  40: "text-[14px]",
};

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Stable hue from a string when the API does not provide one. */
export function hueFrom(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/** Avatar: oklch(var(--av-l) var(--av-c) hue) with initials (board 03). */
export function Avatar({
  name,
  hue,
  size = 24,
  presence,
  ring = true,
  className,
  decorative,
}: {
  name: string;
  hue?: number;
  size?: AvatarSize;
  presence?: boolean;
  /** 2px surface ring that separates stacked avatars. */
  ring?: boolean;
  className?: string;
  /** Hide from assistive tech when the name is already visible next to it. */
  decorative?: boolean;
}) {
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      className={cn(
        "relative inline-flex flex-none select-none items-center justify-center rounded-full font-semibold text-fg",
        fontFor[size],
        ring && "shadow-[0_0_0_2px_var(--surface)]",
        className,
      )}
      style={{ width: size, height: size, background: `oklch(var(--av-l) var(--av-c) ${hue ?? hueFrom(name)})` }}
    >
      {initialsOf(name)}
      {presence && (
        <span
          aria-hidden
          className="absolute -bottom-px -right-px size-[9px] rounded-full bg-ok shadow-[0_0_0_2px_var(--surface)]"
        />
      )}
    </span>
  );
}

export function UnassignedAvatar({ size = 24, className, label = "Unassigned" }: { size?: AvatarSize; className?: string; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full border-[1.5px] border-dashed border-control text-fg-3",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {size >= 28 && <UserRound size={Math.round(size * 0.45)} strokeWidth={1.5} aria-hidden />}
    </span>
  );
}

export function AvatarStack({
  people,
  max = 3,
  size = 24,
  className,
}: {
  people: { id: string; name: string; hue?: number }[];
  max?: number;
  size?: AvatarSize;
  className?: string;
}) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className={cn("flex pl-1.5", className)} aria-label={`${people.length} people`} role="group">
      {shown.map((p) => (
        <Avatar key={p.id} name={p.name} hue={p.hue} size={size} className="-ml-1.5" />
      ))}
      {rest > 0 && (
        <span
          role="img"
          aria-label={`${rest} more`}
          className={cn(
            "-ml-1.5 inline-flex flex-none items-center justify-center rounded-full bg-hover font-semibold text-fg-2 shadow-[0_0_0_2px_var(--surface)]",
            fontFor[size],
          )}
          style={{ width: size, height: size }}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}

/** Project / workspace badge: oklch tinted tile with a 2–3 letter code. */
export function ProjectBadge({
  code,
  hue,
  size = 18,
  className,
}: {
  code: string;
  hue: number;
  size?: 18 | 20 | 22 | 24 | 36;
  className?: string;
}) {
  const font =
    size >= 36 ? "text-[11px] rounded-md" : size >= 22 ? "text-[9px] rounded-[5px]" : "text-[8.5px] rounded-[5px]";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex flex-none select-none items-center justify-center font-mono font-semibold leading-none",
        font,
        className,
      )}
      style={{
        width: size,
        height: size,
        background: `oklch(var(--pk-l) var(--pk-c) ${hue})`,
        color: `oklch(var(--pkt-l) var(--pkt-c) ${hue})`,
      }}
    >
      {code.slice(0, 3)}
    </span>
  );
}
