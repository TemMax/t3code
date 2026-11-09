import type {
  ServerProvider,
  SidebarUsageBarFocus,
  SidebarUsageBarStyle,
} from "@t3tools/contracts";
import {
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  paceRemainingPercent,
} from "@t3tools/shared/usageLimits";

export interface UsageGaugeArc {
  readonly window: LimitPoolWindow;
  readonly remaining: number;
  /** Percent of the window's time left, where even spending would put the remaining quota. */
  readonly pace: number | null;
  readonly shortLabel: string;
  readonly resetsAt: number | null;
}

export interface UsageGauge {
  /** What `sidebarUsageBarHidden` stores to hide this gauge. */
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  /** Set when the gauge tracks a separate limit, such as a weekly limit on one model. */
  readonly name: string | null;
  readonly plan: string | undefined;
  readonly accounts: readonly LimitAccount[];
  readonly outer: UsageGaugeArc;
  readonly inner: UsageGaugeArc | null;
  readonly focus: UsageGaugeArc;
  /** What the hover card lists; the provider's first gauge lists every window. */
  readonly windows: readonly UsageGaugeArc[];
}

const KIND_MINUTES: Record<LimitPoolWindow["kind"], number> = {
  session: 5 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
  other: Number.POSITIVE_INFINITY,
};

function windowMinutes(window: LimitPoolWindow): number {
  return (
    window.members.find((member) => member.window.windowDurationMins)?.window.windowDurationMins ??
    KIND_MINUTES[window.kind]
  );
}

function shortLabel(window: LimitPoolWindow): string {
  const minutes = window.members.find((member) => member.window.windowDurationMins)?.window
    .windowDurationMins;
  if (minutes === undefined) {
    if (window.kind === "weekly") return "7d";
    if (window.kind === "monthly") return "mo";
    return window.label.split(/\s+/)[0] ?? window.label;
  }
  if (minutes < 60) return `${minutes}m`;
  if (minutes <= 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

function toArc(window: LimitPoolWindow, now: number): UsageGaugeArc {
  const paces = window.members.flatMap((member) => {
    const pace = paceRemainingPercent(member.window, now);
    return pace === null ? [] : [pace];
  });
  return {
    window,
    remaining: window.remainingPercent,
    pace:
      paces.length === 0
        ? null
        : Math.round(paces.reduce((sum, pace) => sum + pace, 0) / paces.length),
    shortLabel: shortLabel(window),
    resetsAt: window.resets[0]?.at ?? null,
  };
}

const tightest = (windows: readonly LimitPoolWindow[]) =>
  [...windows].sort((left, right) => left.remainingPercent - right.remainingPercent);

const DURATION_PART = /^(session|daily|weekly|monthly|\d+[- ]?(m|min|minute|h|hour|d|day)s?)$/i;

// "Weekly · Fable" and "Gemini · 5-hour" both count one model or family apart from the rest.
function scopeName(window: LimitPoolWindow): string | null {
  const parts = window.label.split(" · ").map((part) => part.trim());
  if (parts.length < 2) return null;
  return parts.find((part) => !DURATION_PART.test(part)) ?? null;
}

const isShort = (window: LimitPoolWindow) =>
  window.kind === "session" || windowMinutes(window) <= 24 * 60;

function focusArc(focus: SidebarUsageBarFocus, outer: UsageGaugeArc, inner: UsageGaugeArc | null) {
  if (!inner || focus === "long") return outer;
  if (focus === "short") return inner;
  return inner.remaining < outer.remaining ? inner : outer;
}

/**
 * One gauge per separate limit. A short window nests only inside the long window of its own
 * scope; another limit of the same length gets its own gauge, and longer ones stay in the card.
 */
export function buildUsageGauges(
  pools: readonly LimitPool[],
  now: number,
  focus: SidebarUsageBarFocus,
): readonly UsageGauge[] {
  return pools.flatMap((pool) => {
    const windows = displayLimitWindows(pool);
    if (windows.length === 0) return [];
    const arcs = new Map(windows.map((window) => [window, toArc(window, now)]));
    const arc = (window: LimitPoolWindow) => arcs.get(window)!;
    const scopes = new Map<string | null, LimitPoolWindow[]>();
    for (const window of windows) {
      const scope = scopeName(window);
      scopes.set(scope, [...(scopes.get(scope) ?? []), window]);
    }
    const plans = new Set(pool.accounts.map((account) => account.plan));
    const plan = plans.size === 1 ? pool.accounts[0]?.plan : undefined;
    const gauges: UsageGauge[] = [];
    for (const [scope, members] of scopes) {
      const [session] = tightest(members.filter(isShort));
      const long = members.filter((window) => !isShort(window));
      const shortest = Math.min(...long.map(windowMinutes));
      const outers = long.length
        ? long.filter((window) => windowMinutes(window) === shortest)
        : [session!];
      outers.forEach((outerWindow, index) => {
        const outer = arc(outerWindow);
        const inner = index === 0 && session && session !== outerWindow ? arc(session) : null;
        const own =
          index === 0 ? members.filter((window) => !outers.includes(window, 1)) : [outerWindow];
        gauges.push({
          // The provider's first gauge keeps the bare driver, so hiding it survives window changes.
          key: gauges.length === 0 ? pool.driver : `${pool.driver}:${outerWindow.id}`,
          driver: pool.driver,
          name: index === 0 ? scope : (scope ?? outerWindow.label),
          plan,
          accounts: pool.accounts,
          outer,
          inner,
          focus: focusArc(focus, outer, inner),
          windows: (gauges.length === 0 ? windows : own).map(arc),
        });
      });
    }
    return gauges;
  });
}

export type ResolvedUsageBarStyle = Exclude<SidebarUsageBarStyle, "auto">;

const CHIP_WIDTH: Record<ResolvedUsageBarStyle, number> = {
  detailed: 92,
  compact: 80,
  minimal: 30,
};
const CHIP_GAP = 4;

export function resolveUsageBarStyle(
  style: SidebarUsageBarStyle,
  count: number,
  width: number,
): ResolvedUsageBarStyle {
  if (style !== "auto") return style;
  const fits = (candidate: ResolvedUsageBarStyle) =>
    count * CHIP_WIDTH[candidate] + Math.max(0, count - 1) * CHIP_GAP <= width;
  if (fits("detailed")) return "detailed";
  if (fits("compact")) return "compact";
  return "minimal";
}
