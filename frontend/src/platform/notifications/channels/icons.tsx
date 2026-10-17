import type { NotificationChannel } from "@/lib/api/types";

/* Board 38 glyphs, drawn from the design's paths (16 viewBox, round caps). */

export const CHANNEL_PATH: Record<NotificationChannel, string> = {
  in_app: "M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14h3",
  email: "M2.5 4h11v8.5h-11zM2.5 4.5L8 9l5.5-4.5",
  telegram: "M2.5 3.5h11v7.5H7.5L4.5 13.5V11h-2zM5.5 7.25h.01M8 7.25h.01M10.5 7.25h.01",
  sms: "M5 1.5h6a1 1 0 011 1v11a1 1 0 01-1 1H5a1 1 0 01-1-1v-11a1 1 0 011-1zM7 12.5h2",
  push: "M2 3h12v8H2zM6 14h4M8 11v3",
};

export function Glyph({ d, size = 16, stroke = 1.4, className }: { d: string; size?: number; stroke?: number; className?: string }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={d} />
    </svg>
  );
}

export const ChannelIcon = ({ channel, size = 16 }: { channel: NotificationChannel; size?: number }) => <Glyph d={CHANNEL_PATH[channel]} size={size} />;

export const OkGlyph = ({ size = 12 }: { size?: number }) => <Glyph d="M3.5 8.5l3 3 6-7" size={size} stroke={2} />;
export const WarnGlyph = ({ size = 12 }: { size?: number }) => <Glyph d="M8 2.5l6 10.5H2zM8 6.5v3M8 11.3v.1" size={size} stroke={1.6} />;
export const XGlyph = ({ size = 13 }: { size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
    <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
  </svg>
);
export const ShieldGlyph = () => <Glyph d="M8 1.5l5 2v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4z" size={13} stroke={1.5} />;
export const MoonGlyph = () => <Glyph d="M12.5 10.2A5.5 5.5 0 015.8 3.5a5.5 5.5 0 106.7 6.7z" size={16} stroke={1.5} className="text-accent-t" />;
export const CopyGlyph = () => <Glyph d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" size={14} />;
export const ClockGlyph = () => (
  <svg aria-hidden width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2 1.3" />
  </svg>
);

/** The dashed "not connected" dot of a channel status line (design `.ch-dash`). */
export const DashDot = () => <span aria-hidden className="inline-block size-2.5 flex-none rounded-full border-[1.5px] border-dashed border-fg-3" />;

/** The design's small spinner (`.spin`). */
export const Spin = ({ size = 12 }: { size?: number }) => (
  <span aria-hidden className="inline-block flex-none animate-[spin_.7s_linear_infinite] rounded-full border-2 border-line-2 border-t-fg-2" style={{ width: size, height: size }} />
);

/** The success check with the spark ring (design `.ch-okc`). */
export function SparkCheck() {
  return (
    <span className="ch-okc relative inline-flex size-[46px] items-center justify-center rounded-full bg-ok-s text-ok">
      <Glyph d="M3.5 8.5l3 3 6-7" size={20} stroke={2} />
    </span>
  );
}
