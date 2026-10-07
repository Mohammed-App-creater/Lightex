import { ImageResponse } from "next/og";
import type { ReactNode } from "react";
import { markSvg, svgDataUri } from "@/components/brand/icon-svg";

/*
 * Open Graph image (board 35, navy variant), 1200×630: wordmark top-left, "Ship at lightning
 * speed." bottom-left, a three-column mini board on the right with the spark on the done card.
 * Satori only supports flexbox, so the board's grid is rebuilt with flex. Colours are the navy
 * theme tokens as literals (images live outside the theme). Font: next/og's bundled Geist (the
 * repo ships no Inter TTF; see report).
 */

export const alt = "Lightex: Ship at lightning speed.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const C = {
  bg: "#060B18",
  surface: "#0C1326",
  line2: "#2B3A5E",
  text: "#EAF0FF",
  text2: "#A5B2D1",
  text3: "#8794B6",
  accent: "#2B67F5",
  accentS: "rgba(43,103,245,.2)",
  spark: "#5BE0FF",
  todo: "#C4CBE0",
  warn: "#F5B73B",
  ok: "#4ADE80",
  danger: "#FF7A70",
  orange: "#FF9A4D",
};

function Glyph({ kind, color }: { kind: "todo" | "progress" | "done"; color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      {kind === "done" ? (
        <>
          <circle cx="7" cy="7" r="7" fill={color} />
          <path d="M4.2 7.2l2 2 3.6-4" stroke={C.bg} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="6.25" stroke={color} strokeWidth="1.5" fill="none" />
          {kind === "progress" && <path d="M7 3.25A3.75 3.75 0 0 1 7 10.75Z" fill={color} />}
        </>
      )}
    </svg>
  );
}

function Bars({ n, color }: { n: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 1.5, height: 12 }}>
      {[4, 7, 10, 12].map((h, i) => (
        <div key={i} style={{ width: 3, height: h, borderRadius: 1, background: i < n ? color : C.line2 }} />
      ))}
    </div>
  );
}

function Card({ id, widths, bars, barColor, initials, avatar, active, spark }: {
  id: string;
  widths: [string, string];
  bars: number;
  barColor: string;
  initials: string;
  avatar: string;
  active?: boolean;
  spark?: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        width: 132,
        padding: 12,
        borderRadius: 10,
        background: C.surface,
        border: `1px solid ${active ? C.accent : C.line2}`,
        boxShadow: active ? `0 0 0 3px ${C.accentS}` : "none",
      }}
    >
      <div style={{ display: "flex", fontSize: 11, color: C.text3, fontFamily: "monospace" }}>{id}</div>
      <div style={{ display: "flex", height: 7, width: widths[0], borderRadius: 4, background: C.line2 }} />
      <div style={{ display: "flex", height: 7, width: widths[1], borderRadius: 4, background: C.line2 }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Bars n={bars} color={barColor} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: 10,
            background: avatar,
            color: C.text,
            fontSize: 9,
          }}
        >
          {initials}
        </div>
      </div>
      {spark && (
        <svg width="26" height="26" viewBox="-13 -13 26 26" style={{ position: "absolute", right: -9, top: -9 }}>
          <path d="M0-10L2.4-2.4 10 0 2.4 2.4 0 10-2.4 2.4-10 0-2.4-2.4Z" fill={C.spark} />
        </svg>
      )}
    </div>
  );
}

function Column({ label, glyph, color, children }: { label: string; glyph: "todo" | "progress" | "done"; color: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: C.text2 }}>
        <Glyph kind={glyph} color={color} />
        {label}
      </div>
      {children}
    </div>
  );
}

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div style={{ position: "relative", display: "flex", width: "100%", height: "100%", background: C.bg, color: C.text }}>
        <div style={{ position: "absolute", left: 80, top: 80, display: "flex", alignItems: "flex-end", fontSize: 64, letterSpacing: "-0.04em", lineHeight: 1 }}>
          Lighte
          {/* eslint-disable-next-line @next/next/no-img-element -- next/og renders <img>, not next/image */}
          <img src={svgDataUri(markSvg({ bar: C.text, bolt: "#3B7BFF" }))} width={41} height={35} alt="" style={{ marginLeft: 2, marginBottom: 2 }} />
        </div>
        <div style={{ position: "absolute", left: 80, bottom: 96, width: 520, display: "flex", fontSize: 68, lineHeight: "74px", letterSpacing: "-0.035em" }}>
          Ship at lightning speed.
        </div>
        <div
          style={{
            position: "absolute",
            right: 72,
            top: 220,
            width: 470,
            display: "flex",
            gap: 14,
            padding: 18,
            borderRadius: 16,
            background: C.surface,
            border: `1px solid ${C.line2}`,
          }}
        >
          <Column label="Todo" glyph="todo" color={C.todo}>
            <Card id="PRJ-47" widths={["90%", "60%"]} bars={2} barColor={C.warn} initials="JL" avatar="#00565d" />
          </Column>
          <Column label="In progress" glyph="progress" color={C.warn}>
            <Card id="PRJ-42" widths={["84%", "70%"]} bars={4} barColor={C.danger} initials="SP" avatar="#742d31" active />
          </Column>
          <Column label="Done" glyph="done" color={C.ok}>
            <Card id="PRJ-39" widths={["76%", "50%"]} bars={3} barColor={C.orange} initials="AK" avatar="#433e7b" spark />
          </Column>
        </div>
      </div>
    ),
    size,
  );
}
