import type { ReactNode } from "react";
import { useId } from "react";

import type { UsageGaugeArc } from "./sidebarUsageBar.logic";

const START_DEGREES = 135;
const SWEEP_DEGREES = 270;
const SIZE = 28;
// The sidebar background matches --muted in light themes, so the track tints the text color.
const TRACK_COLOR = "color-mix(in oklab, var(--color-foreground) 12%, transparent)";

function Arc({
  arc,
  radius,
  width,
  color,
  paceMarks,
}: {
  readonly arc: UsageGaugeArc;
  readonly radius: number;
  readonly width: number;
  readonly color: string;
  readonly paceMarks: boolean;
}) {
  const maskId = `usage-gauge-${useId().replace(/[^\w-]/g, "")}`;
  const center = SIZE / 2;
  const circumference = 2 * Math.PI * radius;
  const full = (circumference * SWEEP_DEGREES) / 360;
  const filled = (full * arc.remaining) / 100;
  // Round caps add half the stroke width at each end, so dashes shrink by one width to compensate.
  const dash = (length: number) => `${Math.max(0, length - width)} ${circumference}`;
  const pace = paceMarks && arc.pace !== null ? Math.min(97, Math.max(3, arc.pace)) : null;
  const tickRadians =
    pace === null ? 0 : ((START_DEGREES + (SWEEP_DEGREES * pace) / 100) * Math.PI) / 180;
  const along = (offset: number) =>
    [
      center + (radius + offset) * Math.cos(tickRadians),
      center + (radius + offset) * Math.sin(tickRadians),
    ] as const;
  const [gapFromX, gapFromY] = along(-width / 2 - 1);
  const [gapToX, gapToY] = along(width / 2 + 1);
  const [tickFromX, tickFromY] = along(-width / 2 - 0.6);
  const [tickToX, tickToY] = along(width / 2 + 0.6);
  const circle = {
    cx: center,
    cy: center,
    r: radius,
    fill: "none",
    strokeWidth: width,
    strokeLinecap: "round" as const,
    strokeDashoffset: -width / 2,
    transform: `rotate(${START_DEGREES} ${center} ${center})`,
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
            strokeWidth={2.4}
          />
        </mask>
      ) : null}
      <g mask={pace !== null ? `url(#${maskId})` : undefined}>
        <circle {...circle} stroke={TRACK_COLOR} strokeDasharray={dash(full)} />
        {arc.remaining > 0 ? (
          <circle {...circle} stroke={color} strokeDasharray={dash(filled)} />
        ) : null}
      </g>
      {pace !== null ? (
        <line
          x1={tickFromX}
          y1={tickFromY}
          x2={tickToX}
          y2={tickToY}
          stroke="var(--color-foreground)"
          strokeWidth={1.3}
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
