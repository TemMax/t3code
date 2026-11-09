import { ProviderDriverKind } from "@t3tools/contracts";
import { type LimitAccount, collectLimitPools } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { buildUsageGauges, resolveUsageBarStyle } from "./sidebarUsageBar.logic";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

type Window = LimitAccount["limits"]["windows"][number];

const session = (usedPercent: number, resetsInHours = 2.5): Window => ({
  id: "five_hour",
  kind: "session",
  label: "5-hour",
  usedPercent,
  resetsAt: new Date(NOW + resetsInHours * HOUR).toISOString(),
  windowDurationMins: 5 * 60,
});

const weekly = (usedPercent: number, model?: string): Window => ({
  id: model ? `seven_day_${model.toLowerCase()}` : "seven_day",
  kind: "weekly",
  label: model ? `Weekly · ${model}` : "Weekly",
  usedPercent,
  resetsAt: new Date(NOW + 84 * HOUR).toISOString(),
  windowDurationMins: 7 * 24 * 60,
});

const account = (driver: string, windows: readonly Window[], plan?: string): LimitAccount => ({
  key: `${driver}:a`,
  driver: ProviderDriverKind.make(driver),
  displayName: null,
  email: undefined,
  plan,
  accentColor: undefined,
  environments: [],
  sourceLabel: null,
  redeem: null,
  limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
});

const gauges = (
  accounts: readonly LimitAccount[],
  focus: Parameters<typeof buildUsageGauges>[2] = "lowest",
) => buildUsageGauges(collectLimitPools(accounts, NOW), NOW, focus);

describe("buildUsageGauges", () => {
  it("nests the short window inside the long one and focuses the lowest", () => {
    const [gauge] = gauges([account("claudeAgent", [weekly(30), session(80)], "Max")]);
    expect(gauge).toMatchObject({
      driver: "claudeAgent",
      plan: "Max",
      outer: { remaining: 70, shortLabel: "7d", pace: 50 },
      inner: { remaining: 20, shortLabel: "5h", pace: 50 },
      focus: { remaining: 20, shortLabel: "5h" },
    });
  });

  it.each([
    ["short", 20],
    ["long", 70],
  ] as const)("focuses the %s window on request", (focus, remaining) => {
    const [gauge] = gauges([account("claudeAgent", [session(80), weekly(30)])], focus);
    expect(gauge?.focus.remaining).toBe(remaining);
  });

  it("draws one arc for a single window, which every focus reports", () => {
    const [gauge] = gauges([account("codex", [weekly(10)])], "short");
    expect(gauge?.inner).toBeNull();
    expect(gauge?.focus).toBe(gauge?.outer);
  });

  it("gives each separate limit its own gauge instead of nesting it", () => {
    const result = gauges([
      account("claudeAgent", [
        session(10),
        weekly(20),
        weekly(60, "Fable"),
        { id: "monthly_spend", kind: "monthly", label: "Monthly spend", usedPercent: 40 },
      ]),
    ]);
    expect(result).toMatchObject([
      { key: "claudeAgent", name: null, inner: { remaining: 90 }, outer: { remaining: 80 } },
      {
        key: "claudeAgent:seven_day_fable",
        name: "Fable",
        inner: null,
        outer: { remaining: 40 },
        focus: { remaining: 40 },
      },
    ]);
    expect(result[0]?.windows.map((arc) => arc.window.id)).toContain("monthly_spend");
    expect(result[1]?.windows.map((arc) => arc.window.id)).toEqual(["seven_day_fable"]);
  });

  it("draws the long window alone when the plan has no 5-hour limit", () => {
    const result = gauges([account("claudeAgent", [weekly(30), weekly(60, "Fable")])], "short");
    expect(result).toMatchObject([
      { name: null, inner: null, focus: { remaining: 70 } },
      { name: "Fable", inner: null, focus: { remaining: 40 } },
    ]);
  });

  it("keeps a scoped 5-hour window inside its own scope", () => {
    const window = (id: string, label: string, minutes: number, usedPercent: number): Window => ({
      id,
      kind: minutes < 24 * 60 ? "session" : "weekly",
      label,
      usedPercent,
      windowDurationMins: minutes,
    });
    const result = gauges([
      account("antigravity", [
        window("gemini-5h", "Gemini · 5-hour", 300, 10),
        window("gemini-weekly", "Gemini · Weekly", 10080, 20),
        window("3p-weekly", "Claude & GPT (shared) · Weekly", 10080, 50),
      ]),
    ]);
    expect(result).toMatchObject([
      { name: "Gemini", inner: { remaining: 90 }, outer: { remaining: 80 } },
      { name: "Claude & GPT (shared)", inner: null, outer: { remaining: 50 } },
    ]);
  });

  it("skips providers that report no windows", () => {
    const result = gauges([account("claudeAgent", [session(10)]), account("cursor", [])]);
    expect(result.map((gauge) => gauge.driver)).toEqual(["claudeAgent"]);
  });
});

describe("resolveUsageBarStyle", () => {
  it.each([
    ["detailed", 1, 10, "detailed"],
    ["auto", 2, 240, "detailed"],
    ["auto", 3, 260, "compact"],
    ["auto", 6, 200, "minimal"],
    ["auto", 2, 0, "minimal"],
  ] as const)("%s with %i gauges in %ipx renders %s", (style, count, width, expected) => {
    expect(resolveUsageBarStyle(style, count, width)).toBe(expected);
  });
});
