import type { ReactNode } from "react";
import { useId } from "react";

import { cn } from "../../lib/utils";
import type { UsageGaugeArc } from "./sidebarUsageBar.logic";

const START_DEGREES = 135;
const SWEEP_DEGREES = 270;
const SIZE = 28;
// The sidebar background matches --muted in light themes, so the track tints the text color.
const TRACK_COLOR = "color-mix(in oklab, var(--color-foreground) 12%, transparent)";

/** Pace within a couple of percent of what is left reads as on pace, so no reserve or debt is drawn. */
const ON_PACE_PERCENT = 3;

function Arc({
  arc,
  radius,
  width,
  color,
  paceMarks,
  start = START_DEGREES,
  sweep = SWEEP_DEGREES,
  emphasis = false,
}: {
  readonly arc: UsageGaugeArc;
  readonly radius: number;
  readonly width: number;
  readonly color: string;
  readonly paceMarks: boolean;
  readonly start?: number;
  readonly sweep?: number;
  /** A heavier pace mark, with the stretch between pace and what is left drawn as reserve or debt. */
  readonly emphasis?: boolean;
}) {
  const maskId = `usage-gauge-${useId().replace(/[^\w-]/g, "")}`;
  const center = SIZE / 2;
  const circumference = 2 * Math.PI * radius;
  const full = (circumference * sweep) / 360;
  // Round caps add half the stroke width at each end, so dashes shrink by one width to compensate.
  const dash = (length: number) => `${Math.max(0, length - width)} ${circumference}`;
  const pace = paceMarks && arc.pace !== null ? Math.min(97, Math.max(3, arc.pace)) : null;
  const split =
    emphasis && pace !== null && Math.abs(arc.remaining - pace) >= ON_PACE_PERCENT ? pace : null;
  const solid = split === null ? arc.remaining : Math.min(arc.remaining, split);
  const filled = (full * solid) / 100;
  const tickRadians = pace === null ? 0 : ((start + (sweep * pace) / 100) * Math.PI) / 180;
  const along = (offset: number) =>
    [
      center + (radius + offset) * Math.cos(tickRadians),
      center + (radius + offset) * Math.sin(tickRadians),
    ] as const;
  const overhang = emphasis ? 1.7 : 0.6;
  const [gapFromX, gapFromY] = along(-width / 2 - overhang - 0.4);
  const [gapToX, gapToY] = along(width / 2 + overhang + 0.4);
  const [tickFromX, tickFromY] = along(-width / 2 - overhang);
  const [tickToX, tickToY] = along(width / 2 + overhang);
  const circle = {
    cx: center,
    cy: center,
    r: radius,
    fill: "none",
    strokeWidth: width,
    strokeLinecap: "round" as const,
    strokeDashoffset: -width / 2,
    transform: `rotate(${start} ${center} ${center})`,
  };
  return (
    <>
      {pace !== null ? (
        <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={SIZE} height={SIZE}>
          <rect width={SIZE} height={SIZE} fill="var(--color-white)" />
          <line
            x1={gapFromX}
            y1={gapFromY}
            x2={gapToX}
            y2={gapToY}
            stroke="var(--color-black)"
            strokeWidth={emphasis ? 3.6 : 2.4}
          />
        </mask>
      ) : null}
      <g mask={pace !== null ? `url(#${maskId})` : undefined}>
        <circle {...circle} stroke={TRACK_COLOR} strokeDasharray={dash(full)} />
        {split !== null ? (
          // Drawn from the start and covered by the fill, so its far end keeps the round cap.
          <circle
            {...circle}
            stroke={arc.remaining > split ? "var(--color-success)" : "var(--color-destructive)"}
            strokeDasharray={dash((full * Math.max(arc.remaining, split)) / 100)}
          />
        ) : null}
        {solid > 0 ? <circle {...circle} stroke={color} strokeDasharray={dash(filled)} /> : null}
      </g>
      {pace !== null ? (
        <line
          x1={tickFromX}
          y1={tickFromY}
          x2={tickToX}
          y2={tickToY}
          stroke="var(--color-foreground)"
          strokeWidth={emphasis ? 1.9 : 1.3}
          strokeLinecap="round"
        />
      ) : null}
    </>
  );
}

/** A 270° gauge: the outer arc is the long window, the dimmer inner arc the short one. */
export function UsageGauge({
  outer,
  inner,
  color,
  paceMarks,
  children,
}: {
  readonly outer: UsageGaugeArc;
  readonly inner: UsageGaugeArc | null;
  readonly color: string;
  readonly paceMarks: boolean;
  readonly children?: ReactNode;
}) {
  const width = inner ? 2.5 : 3.2;
  const outerRadius = SIZE / 2 - width / 2 - 1;
  return (
    <span className="relative inline-flex size-7 shrink-0 items-center justify-center">
      <svg
        aria-hidden
        className="absolute inset-0"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
      >
        <Arc arc={outer} radius={outerRadius} width={width} color={color} paceMarks={paceMarks} />
        {inner ? (
          <g opacity={0.5}>
            <Arc
              arc={inner}
              radius={outerRadius - width - 1.5}
              width={width}
              color={color}
              paceMarks={paceMarks}
            />
          </g>
        ) : null}
      </svg>
      {children}
    </span>
  );
}

const HALF_START_DEGREES = 105;
const HALF_SWEEP_DEGREES = 150;
const HALF_WIDTH = 2.7;

/** A ring split in two, both halves filling upward: the left one is the short window, the right one the long. */
export function UsageHalves({
  left,
  right,
  color,
  paceMarks,
  children,
}: {
  readonly left: UsageGaugeArc | null;
  readonly right: UsageGaugeArc;
  readonly color: string;
  readonly paceMarks: boolean;
  readonly children?: ReactNode;
}) {
  const half = (arc: UsageGaugeArc) => (
    <Arc
      arc={arc}
      radius={SIZE / 2 - HALF_WIDTH / 2 - 1.25}
      width={HALF_WIDTH}
      color={color}
      paceMarks={paceMarks}
      start={HALF_START_DEGREES}
      sweep={HALF_SWEEP_DEGREES}
      emphasis
    />
  );
  return (
    <span className="relative inline-flex size-7 shrink-0 items-center justify-center">
      <svg
        aria-hidden
        className="absolute inset-0 overflow-visible"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
      >
        {half(left ?? right)}
        <g transform={`translate(${SIZE} 0) scale(-1 1)`}>{half(right)}</g>
      </svg>
      {children}
    </span>
  );
}

/** One window as a rail: the fill is what is left, the mark is where even spending would be. */
export function UsageRail({
  arc,
  color,
  paceMarks,
  className,
}: {
  readonly arc: UsageGaugeArc;
  readonly color: string;
  readonly paceMarks: boolean;
  readonly className?: string;
}) {
  const pace = paceMarks && arc.pace !== null ? Math.min(98, Math.max(2, arc.pace)) : null;
  const split = pace !== null && Math.abs(arc.remaining - pace) >= ON_PACE_PERCENT ? pace : null;
  const solid = split === null ? arc.remaining : Math.min(arc.remaining, split);
  const reserve = split !== null && arc.remaining > split;
  return (
    <span
      aria-hidden
      className={cn("relative block h-1 shrink-0 rounded-full", className)}
      style={{ background: TRACK_COLOR }}
    >
      <span
        className={cn(
          "absolute inset-y-0 start-0 rounded-full",
          split !== null && "rounded-e-none",
        )}
        style={{ width: `${solid}%`, background: color }}
      />
      {split !== null ? (
        <span
          className={cn(
            "absolute inset-y-0",
            reserve ? "rounded-e-full bg-success" : "bg-destructive",
          )}
          style={{ insetInlineStart: `${solid}%`, width: `${Math.abs(arc.remaining - split)}%` }}
        />
      ) : null}
      {pace !== null ? (
        <span
          className="absolute -inset-y-[3px] w-0.5 -translate-x-1/2 rounded-full bg-foreground ring-1 ring-sidebar rtl:translate-x-1/2"
          style={{ insetInlineStart: `${pace}%` }}
        />
      ) : null}
    </span>
  );
}
