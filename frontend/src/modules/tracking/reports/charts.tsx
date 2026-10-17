"use client";

import { useState, type ReactElement } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  BurndownPoint,
  CycleBin,
  ThroughputPoint,
  VelocityPoint,
} from "@/lib/api/types";
import {
  ACTIVE_BAR_CLASS,
  BarsIcon,
  ChartCard,
  ChartEmpty,
  ChartError,
  ChartSkeleton,
  chartStyle,
  DataTable,
  HOVER_FILL,
  Legend,
  MARGIN,
  NotEnoughData,
  TableToggle,
  TipCard,
  TrendIcon,
  X_AXIS,
  XTick,
  Y_AXIS,
  YTick,
  useBarSize,
} from "./chart-kit";
import {
  burndownSummary,
  fmtDays,
  niceMax,
  shortDate,
  spanLabel,
  yTicks,
} from "./lib";

/*
 * The four XY charts of board 17, drawn with Recharts and styled to the spec:
 * 3 y ticks (max / half / 0), mono 10.5px labels, line gridlines, no axis lines, a custom
 * `.rp-tip` tooltip, 700ms draw-in (off under reduced motion). Recharts' accessibility layer
 * makes every chart focusable; arrow keys move between data points and show the tooltip.
 */

type QueryLike<T> = {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  isRefetching: boolean;
  refetch: () => unknown;
};

type Common = { reduce: boolean; mobile: boolean };

const anim = (reduce: boolean, begin = 0) =>
  ({
    isAnimationActive: !reduce,
    animationDuration: 700,
    animationEasing: "ease-out",
    animationBegin: begin,
  }) as const;

const tipProps = {
  isAnimationActive: false,
  offset: 10,
  position: { y: 4 },
  allowEscapeViewBox: { x: false, y: true },
  wrapperStyle: { zIndex: 6, outline: "none" },
} as const;

/** Board 33 widgets: the chart fills its card body. */
const FILL = { width: "100%", height: "100%" } as const;

const LINE_CURSOR = { stroke: "var(--text-3)", strokeWidth: 1 };
const ACTIVE_DOT = {
  r: 4.5,
  fill: "var(--c1)",
  stroke: "var(--surface)",
  strokeWidth: 2,
};

function datum<T>(p: {
  active?: boolean;
  payload?: readonly { payload?: unknown }[];
}): T | null {
  if (!p.active || !p.payload?.length) return null;
  return (p.payload[0]?.payload as T) ?? null;
}

function Grid() {
  return (
    <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="" />
  );
}
function Baseline() {
  return (
    <ReferenceLine y={0} stroke="var(--line-2)" ifOverflow="extendDomain" />
  );
}

type DotProps = { cx?: number; cy?: number; index?: number };

/* ───────────── 1 · Sprint burndown ───────────── */

type BurnRow = {
  i: number;
  date: string;
  remaining: number | null;
  ideal: number;
  idealExact: number;
};

export function BurndownCard({
  q,
  sprintNumber,
  reduce,
  mobile,
}: Common & {
  q: QueryLike<{
    sprint: {
      id: string;
      name: string;
      startDate: string;
      endDate: string;
    } | null;
    points: BurndownPoint[];
  }>;
  sprintNumber?: number;
}) {
  const [table, setTable] = useState(false);
  const sprint = q.data?.sprint ?? null;
  const points = q.data?.points ?? [];
  const name =
    sprint?.name ?? (sprintNumber ? `Sprint ${sprintNumber}` : "Sprint");
  const hasData = !!sprint && points.length > 1;

  let body: ReactElement;
  if (q.isPending) body = <ChartSkeleton height={mobile ? 190 : 220} />;
  else if (q.isError)
    body = <ChartError onRetry={() => q.refetch()} retrying={q.isRefetching} />;
  else if (!hasData)
    body = (
      <ChartEmpty
        icon={<TrendIcon />}
        title="No active sprint"
        caption="Start a sprint to see its burndown"
      />
    );
  else if (table)
    body = (
      <DataTable
        caption={`${name} burndown`}
        columns={["Day", "Remaining", "Ideal"]}
        rows={points.map((p) => [
          shortDate(p.date),
          p.remaining ?? "—",
          p.ideal,
        ])}
      />
    );
  else
    body = (
      <BurndownChart
        points={points}
        name={name}
        reduce={reduce}
        mobile={mobile}
      />
    );

  return (
    <ChartCard
      span2
      title="Sprint burndown"
      meta={
        sprint
          ? `${name} · ${spanLabel(sprint.startDate, sprint.endDate)}`
          : undefined
      }
      toggle={
        hasData ? (
          <TableToggle
            pressed={table}
            onToggle={() => setTable((t) => !t)}
            label="View as table"
          />
        ) : undefined
      }
      legend={
        hasData ? (
          <Legend
            items={[
              { kind: "line", label: "Remaining" },
              { kind: "dash", label: "Ideal" },
            ]}
          />
        ) : undefined
      }
    >
      {body}
    </ChartCard>
  );
}

/**
 * The burndown chart body. Board 33: exported for the dashboard widget, which passes `fill` (the
 * chart takes its card's size instead of the design aspect ratio), a shorter tooltip label and
 * the widget's aria text.
 */
export function BurndownChart({
  points,
  name,
  reduce,
  mobile,
  fill,
  remainingLabel = "pts remaining",
  ariaText,
  area,
}: Common & { points: BurndownPoint[]; name: string; fill?: boolean; remainingLabel?: string; ariaText?: string; area?: boolean }) {
  const n = points.length;
  const start = points[0]?.ideal ?? 0;
  const { text, todayIdx } = burndownSummary(name, points);
  const rows: BurnRow[] = points.map((p, i) => ({
    i,
    date: p.date,
    remaining: p.remaining,
    ideal: p.ideal,
    idealExact: start * (1 - i / Math.max(1, n - 1)),
  }));
  const max = niceMax(
    Math.max(start, ...points.map((p) => p.remaining ?? 0)),
    10,
  );
  const ticks = Array.from(new Set([0, todayIdx, n - 1].filter((t) => t >= 0)));
  const fmtX = (v: number | string) =>
    v === todayIdx ? "Today" : shortDate(rows[Number(v)]?.date ?? "");
  const [w, h] = mobile ? [296, 170] : [572, 200];

  const endDot = (p: DotProps) => {
    if (p.index !== todayIdx || p.cx == null || p.cy == null)
      return <g key={`d${p.index}`} />;
    const v = rows[todayIdx]?.remaining;
    return (
      <g key="end">
        <circle
          cx={p.cx}
          cy={p.cy}
          r={4.5}
          fill="var(--c1)"
          stroke="var(--surface)"
          strokeWidth={2}
        />
        <text
          x={p.cx + 9}
          y={p.cy - 6}
          className="fill-fg text-[12px] font-semibold"
        >
          {v}
        </text>
      </g>
    );
  };

  return (
    <ComposedChart
      responsive
      data={rows}
      margin={{ ...MARGIN, right: 14 }}
      style={fill ? FILL : chartStyle(w, h)}
      title={ariaText ?? text}
      accessibilityLayer
    >
      <Grid />
      <XAxis
        {...X_AXIS}
        dataKey="i"
        type="number"
        domain={[-0.5, n - 0.5]}
        ticks={ticks}
        interval={0}
        tick={<XTick format={fmtX} today={todayIdx} />}
      />
      <YAxis
        {...Y_AXIS}
        domain={[0, max]}
        ticks={yTicks(max)}
        tick={<YTick />}
      />
      <Baseline />
      {todayIdx >= 0 && <ReferenceLine x={todayIdx} stroke="var(--line-2)" />}
      <Tooltip
        {...tipProps}
        cursor={LINE_CURSOR}
        content={(p) => {
          const d = datum<BurnRow>(p);
          if (!d) return null;
          return (
            <TipCard
              head={`${shortDate(d.date)}${d.i === todayIdx ? " · today" : ""}`}
              rows={[
                ...(d.remaining != null
                  ? [
                      {
                        kind: "line" as const,
                        value: d.remaining,
                        label: remainingLabel,
                      },
                    ]
                  : []),
                { kind: "dash" as const, value: d.ideal, label: "ideal" },
              ]}
            />
          );
        }}
      />
      <Line
        dataKey="idealExact"
        name="Ideal"
        type="linear"
        stroke="var(--cref)"
        strokeWidth={1.5}
        strokeDasharray="4 4"
        dot={false}
        activeDot={false}
        {...anim(reduce)}
      />
      {area && (
        <Area dataKey="remaining" type="linear" stroke="none" fill="var(--c1)" fillOpacity={0.1} connectNulls={false} activeDot={false} isAnimationActive={false} tooltipType="none" />
      )}
      <Line
        dataKey="remaining"
        name="Remaining"
        type="linear"
        stroke="var(--c1)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        connectNulls={false}
        dot={endDot}
        activeDot={ACTIVE_DOT}
        {...anim(reduce)}
      />
    </ComposedChart>
  );
}

/* ───────────── 2 · Velocity ───────────── */

export function VelocityCard({
  q,
  reduce,
  mobile,
}: Common & {
  q: QueryLike<{
    points: VelocityPoint[];
    insufficient: boolean;
    completedSprints: number;
  }>;
}) {
  const [table, setTable] = useState(false);
  const all = q.data?.points ?? [];
  const pts = mobile ? all.slice(-4) : all;
  const ready = !!q.data && !q.data.insufficient && pts.length > 0;
  const avg = pts.length
    ? Math.round(pts.reduce((a, p) => a + p.completed, 0) / pts.length)
    : 0;

  let body: ReactElement;
  if (q.isPending) body = <ChartSkeleton height={mobile ? 190 : 200} />;
  else if (q.isError)
    body = <ChartError onRetry={() => q.refetch()} retrying={q.isRefetching} />;
  else if (!ready)
    body = (
      <NotEnoughData
        icon={<BarsIcon />}
        completed={Math.min(q.data?.completedSprints ?? 0, q.data?.points.length ?? 0)}
      />
    );
  else if (table)
    body = (
      <DataTable
        caption="Velocity by sprint"
        columns={["Sprint", "Committed", "Completed"]}
        rows={pts.map((p) => [p.sprint, p.committed, p.completed])}
      />
    );
  else
    body = (
      <VelocityChart pts={pts} avg={avg} reduce={reduce} mobile={mobile} />
    );

  return (
    <ChartCard
      title="Velocity"
      meta={ready ? `avg ${avg} pts` : undefined}
      toggle={
        ready ? (
          <TableToggle
            pressed={table}
            onToggle={() => setTable((t) => !t)}
            label="Table"
            ariaLabel="View velocity as table"
          />
        ) : undefined
      }
      legend={
        ready ? (
          <Legend
            items={[
              { kind: "rect", label: "Committed", color: "var(--c2)" },
              { kind: "rect", label: "Completed", color: "var(--c1)" },
            ]}
          />
        ) : undefined
      }
    >
      {body}
    </ChartCard>
  );
}

/** The velocity chart body. Board 33: exported for the dashboard widget (`fill`, aria text). */
export function VelocityChart({
  pts,
  avg,
  reduce,
  mobile,
  fill,
  ariaText,
}: Common & { pts: VelocityPoint[]; avg: number; fill?: boolean; ariaText?: string }) {
  const max = niceMax(
    Math.max(...pts.flatMap((p) => [p.committed, p.completed])),
    10,
  );
  const [w, h] = mobile ? [296, 170] : [247, 190];
  const first = pts[0]?.sprint ?? "";
  const last = pts[pts.length - 1]?.sprint ?? "";
  const [ref, barSize] = useBarSize(pts.length, 0.3, 5);
  return (
    <div ref={ref} className={fill ? "h-full min-h-0 min-w-0" : "min-w-0"}>
      <BarChart
        responsive
        data={pts}
        margin={MARGIN}
        style={fill ? FILL : chartStyle(w, h)}
        barGap={2}
        barSize={barSize || undefined}
        title={ariaText ?? `Velocity ${first}–${last}: average ${avg} points completed per sprint.`}
        accessibilityLayer
      >
        <Grid />
        <XAxis {...X_AXIS} dataKey="sprint" interval={0} tick={<XTick />} />
        <YAxis
          {...Y_AXIS}
          domain={[0, max]}
          ticks={yTicks(max)}
          tick={<YTick />}
        />
        <Baseline />
        <Tooltip
          {...tipProps}
          cursor={{ fill: HOVER_FILL }}
          content={(p) => {
            const d = datum<VelocityPoint>(p);
            if (!d) return null;
            const pct = d.committed
              ? Math.round((d.completed / d.committed) * 100)
              : 0;
            return (
              <TipCard
                head={`Sprint ${d.sprint.replace(/^S/, "")} · ${pct}%`}
                rows={[
                  {
                    kind: "rect",
                    color: "var(--c1)",
                    value: d.completed,
                    label: "completed",
                  },
                  {
                    kind: "rect",
                    color: "var(--c2)",
                    value: d.committed,
                    label: "committed",
                  },
                ]}
              />
            );
          }}
        />
        <Bar
          dataKey="committed"
          name="Committed"
          fill="var(--c2)"
          radius={[4, 4, 0, 0]}
          activeBar={{ className: ACTIVE_BAR_CLASS }}
          {...anim(reduce)}
        />
        <Bar
          dataKey="completed"
          name="Completed"
          fill="var(--c1)"
          radius={[4, 4, 0, 0]}
          activeBar={{ className: ACTIVE_BAR_CLASS }}
          {...anim(reduce, 60)}
        />
      </BarChart>
    </div>
  );
}

/* ───────────── 3 · Cycle time ───────────── */

export function CycleTimeCard({
  q,
  completedSprints,
  reduce,
  mobile,
}: Common & {
  q: QueryLike<{
    bins: CycleBin[];
    total: number;
    medianDays: number;
    insufficient: boolean;
  }>;
  completedSprints: number;
}) {
  const d = q.data;
  const ready = !!d && !d.insufficient && d.total > 0;
  let body: ReactElement;
  if (q.isPending) body = <ChartSkeleton height={mobile ? 170 : 190} />;
  else if (q.isError)
    body = <ChartError onRetry={() => q.refetch()} retrying={q.isRefetching} />;
  else if (!ready)
    body = <NotEnoughData icon={<BarsIcon />} completed={completedSprints} />;
  else
    body = (
      <CycleChart
        bins={d.bins}
        total={d.total}
        reduce={reduce}
        mobile={mobile}
      />
    );
  return (
    <ChartCard
      title="Cycle time"
      meta={
        ready ? `${d.total} tasks · median ${fmtDays(d.medianDays)}` : undefined
      }
    >
      {body}
    </ChartCard>
  );
}

function CycleChart({
  bins,
  total,
  reduce,
  mobile,
}: Common & { bins: CycleBin[]; total: number }) {
  const max = niceMax(Math.max(...bins.map((b) => b.count)), 5);
  const [w, h] = mobile ? [296, 150] : [247, 170];
  const top = bins.reduce((a, b) => (b.count > a.count ? b : a), bins[0]!);
  const [ref, barSize] = useBarSize(bins.length, 0.62, 6);
  return (
    <div ref={ref} className="min-w-0">
      <BarChart
        responsive
        data={bins}
        margin={MARGIN}
        style={chartStyle(w, h)}
        barSize={barSize || undefined}
        title={`Cycle time distribution: ${total} tasks, most in ${top.label}.`}
        accessibilityLayer
      >
        <Grid />
        <XAxis {...X_AXIS} dataKey="label" interval={0} tick={<XTick />} />
        <YAxis
          {...Y_AXIS}
          domain={[0, max]}
          ticks={yTicks(max)}
          tick={<YTick />}
        />
        <Baseline />
        <Tooltip
          {...tipProps}
          cursor={{ fill: HOVER_FILL }}
          content={(p) => {
            const b = datum<CycleBin>(p);
            if (!b) return null;
            const pct = total ? Math.round((b.count / total) * 100) : 0;
            return (
              <TipCard
                head={b.label}
                rows={[
                  { kind: "rect", value: b.count, label: `tasks · ${pct}%` },
                ]}
              />
            );
          }}
        />
        <Bar
          dataKey="count"
          name="Tasks"
          fill="var(--c1)"
          radius={[4, 4, 0, 0]}
          activeBar={{ className: ACTIVE_BAR_CLASS }}
          {...anim(reduce)}
        />
      </BarChart>
    </div>
  );
}

/* ───────────── 4 · Throughput ───────────── */

type ThroughRow = { i: number; week: string; done: number };

export function ThroughputCard({
  q,
  completedSprints,
  reduce,
  mobile,
}: Common & {
  q: QueryLike<{ points: ThroughputPoint[]; insufficient: boolean }>;
  completedSprints: number;
}) {
  const d = q.data;
  const ready = !!d && !d.insufficient && d.points.length > 1;
  let body: ReactElement;
  if (q.isPending) body = <ChartSkeleton height={mobile ? 170 : 190} />;
  else if (q.isError)
    body = <ChartError onRetry={() => q.refetch()} retrying={q.isRefetching} />;
  else if (!ready)
    body = <NotEnoughData icon={<TrendIcon />} completed={completedSprints} />;
  else
    body = (
      <ThroughputChart points={d.points} reduce={reduce} mobile={mobile} />
    );
  return (
    <ChartCard title="Throughput" meta={ready ? "tasks / week" : undefined}>
      {body}
    </ChartCard>
  );
}

function ThroughputChart({
  points,
  reduce,
  mobile,
}: Common & { points: ThroughputPoint[] }) {
  const n = points.length;
  const rows: ThroughRow[] = points.map((p, i) => ({
    i,
    week: p.week,
    done: p.done,
  }));
  const max = niceMax(Math.max(...points.map((p) => p.done)), 5);
  const [w, h] = mobile ? [296, 150] : [247, 170];
  const ticks = Array.from(new Set([0, Math.floor((n - 1) / 2), n - 1]));
  const fmtX = (v: number | string) => shortDate(rows[Number(v)]?.week ?? "");
  const last = rows[n - 1]!;
  const avg =
    Math.round((points.reduce((a, p) => a + p.done, 0) / n) * 10) / 10;

  const endDot = (p: DotProps) => {
    if (p.index !== n - 1 || p.cx == null || p.cy == null)
      return <g key={`d${p.index}`} />;
    return (
      <g key="end">
        <circle
          cx={p.cx}
          cy={p.cy}
          r={4.5}
          fill="var(--c1)"
          stroke="var(--surface)"
          strokeWidth={2}
        />
        <text
          x={p.cx}
          y={p.cy - 10}
          textAnchor="middle"
          className="fill-fg text-[12px] font-semibold"
        >
          {last.done}
        </text>
      </g>
    );
  };

  return (
    <AreaChart
      responsive
      data={rows}
      margin={{ ...MARGIN, top: 14, right: 10 }}
      style={chartStyle(w, h)}
      title={`Throughput: ${n} weeks, average ${avg} tasks per week, ${last.done} in the week of ${shortDate(last.week)}.`}
      accessibilityLayer
    >
      <Grid />
      <XAxis
        {...X_AXIS}
        dataKey="i"
        type="number"
        domain={[-0.5, n - 0.5]}
        ticks={ticks}
        interval={0}
        tick={<XTick format={fmtX} />}
      />
      <YAxis
        {...Y_AXIS}
        domain={[0, max]}
        ticks={yTicks(max)}
        tick={<YTick />}
      />
      <Baseline />
      <Tooltip
        {...tipProps}
        cursor={LINE_CURSOR}
        content={(p) => {
          const d = datum<ThroughRow>(p);
          if (!d) return null;
          return (
            <TipCard
              head={`Week of ${shortDate(d.week)}`}
              rows={[{ kind: "line", value: d.done, label: "tasks completed" }]}
            />
          );
        }}
      />
      <Area
        dataKey="done"
        name="Tasks completed"
        type="linear"
        stroke="var(--c1)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="var(--c1)"
        fillOpacity={0.1}
        dot={endDot}
        activeDot={ACTIVE_DOT}
        {...anim(reduce)}
      />
    </AreaChart>
  );
}
