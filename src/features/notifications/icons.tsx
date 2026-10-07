import type { NotificationType } from "@/lib/api/types";
import { EVENTS } from "./events";

/* Icons drawn from the design board paths (16 viewBox, round caps). */

function Svg({ d, size, stroke = 1.5, color, className }: { d: string; size: number; stroke?: number; color?: string; className?: string }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={d} />
    </svg>
  );
}

export function EventIcon({ type, size = 15, stroke = 1.5 }: { type: NotificationType; size?: number; stroke?: number }) {
  const ev = EVENTS[type];
  return <Svg d={ev.path} size={size} stroke={stroke} color={ev.color} />;
}

export const DoubleCheckIcon = ({ size = 15 }: { size?: number }) => <Svg d="M1.5 8.5l3 3 6.5-7M7.5 11.5l1 0 6-7" size={size} />;
export const CheckIcon = ({ size = 15, className }: { size?: number; className?: string }) => (
  <Svg d="M3.5 8.5l3 3 6-7" size={size} stroke={1.7} className={className} />
);
export const OpenIcon = ({ size = 15 }: { size?: number }) => <Svg d="M6 3.5h6.5V10M12.5 3.5l-9 9" size={size} />;
export const CloseIcon = ({ size = 14 }: { size?: number }) => <Svg d="M4 4l8 8M12 4l-8 8" size={size} />;
export const ArrowRightIcon = ({ size = 14 }: { size?: number }) => <Svg d="M3 8h10M9 4l4 4-4 4" size={size} />;

export function HollowCircleIcon({ size = 15 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="8" cy="8" r="3.2" />
    </svg>
  );
}

export function AlertIcon({ size = 22 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <circle cx="12" cy="16.5" r=".6" fill="currentColor" />
    </svg>
  );
}
