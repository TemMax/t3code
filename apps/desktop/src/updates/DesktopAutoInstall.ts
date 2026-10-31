import { DEFAULT_CLIENT_SETTINGS, type DesktopUpdateState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

export const AUTO_INSTALL_MIN_SYSTEM_IDLE_SECONDS = 5 * 60;
/** Windows report on change and every minute; a closed window's report expires after this. */
export const AGENT_ACTIVITY_REPORT_TTL_MS = 3 * 60 * 1000;

export interface AgentActivityReport {
  readonly busy: boolean;
  readonly reportedAtMs: number;
}

export interface AutoInstallInput {
  readonly enabled: boolean;
  readonly state: DesktopUpdateState;
  readonly reports: ReadonlyArray<AgentActivityReport>;
  readonly nowMs: number;
  readonly systemIdleSeconds: number;
  readonly attemptedVersions: ReadonlySet<string>;
}

export type AutoInstallStep =
  | { readonly action: "download" }
  | { readonly action: "install"; readonly version: string }
  | { readonly action: "wait" };

const WAIT: AutoInstallStep = { action: "wait" };

export function nextAutoInstallStep(input: AutoInstallInput): AutoInstallStep {
  const { state } = input;
  if (!input.enabled || !state.enabled) return WAIT;
  const target = state.downloadedVersion ?? state.availableVersion;
  // A failed install retries only when the user asks; repeating it would restart backends in a loop.
  if (
    target !== null &&
    (target === state.notAppliedVersion || input.attemptedVersions.has(target))
  ) {
    return WAIT;
  }
  if (state.status === "available") return { action: "download" };
  if (state.status !== "downloaded" || state.downloadedVersion === null) return WAIT;

  const fresh = input.reports.filter(
    (report) => input.nowMs - report.reportedAtMs <= AGENT_ACTIVITY_REPORT_TTL_MS,
  );
  if (fresh.length === 0 || fresh.some((report) => report.busy)) return WAIT;
  if (input.systemIdleSeconds < AUTO_INSTALL_MIN_SYSTEM_IDLE_SECONDS) return WAIT;
  return { action: "install", version: state.downloadedVersion };
}

const AUTO_INSTALL_TICK = "1 minute";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-auto-install");

export class DesktopAutoInstall extends Context.Service<
  DesktopAutoInstall,
  {
    readonly reportAgentActivity: (windowId: number, busy: boolean) => Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/updates/DesktopAutoInstall") {}

/** @public */
export const make = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const reportsRef = yield* Ref.make<ReadonlyMap<number, AgentActivityReport>>(new Map());
  const attemptedRef = yield* Ref.make<ReadonlySet<string>>(new Set());

  const enabled = clientSettings.get.pipe(
    Effect.map(Option.getOrElse(() => DEFAULT_CLIENT_SETTINGS)),
    Effect.orElseSucceed(() => DEFAULT_CLIENT_SETTINGS),
    Effect.map((settings) => settings.autoInstallDesktopUpdates),
  );

  const tick = Effect.gen(function* () {
    const step = nextAutoInstallStep({
      enabled: yield* enabled,
      state: yield* updates.getState,
      reports: [...(yield* Ref.get(reportsRef)).values()],
      nowMs: yield* Clock.currentTimeMillis,
      systemIdleSeconds: yield* powerMonitor.getSystemIdleTime,
      attemptedVersions: yield* Ref.get(attemptedRef),
    });
    if (step.action === "download") {
      yield* logInfo("downloading update automatically");
      yield* updates.download;
    } else if (step.action === "install") {
      yield* Ref.update(attemptedRef, (versions) => new Set([...versions, step.version]));
      yield* logInfo("installing update automatically", { version: step.version });
      yield* updates.installPrepared(step.version);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("automatic update tick failed", {
        cause: DesktopUpdates.describeUpdateErrorCause(cause),
      }),
    ),
    Effect.withSpan("desktop.autoInstall.tick"),
  );

  return DesktopAutoInstall.of({
    reportAgentActivity: Effect.fn("desktop.autoInstall.reportAgentActivity")(function* (
      windowId: number,
      busy: boolean,
    ) {
      const reportedAtMs = yield* Clock.currentTimeMillis;
      yield* Ref.update(reportsRef, (reports) => {
        const next = new Map(
          [...reports].filter(
            ([, report]) => reportedAtMs - report.reportedAtMs <= AGENT_ACTIVITY_REPORT_TTL_MS,
          ),
        );
        next.set(windowId, { busy, reportedAtMs });
        return next;
      });
    }),
    start: tick.pipe(
      Effect.repeat(Schedule.spaced(AUTO_INSTALL_TICK)),
      Effect.forkScoped,
      Effect.asVoid,
    ),
  });
});

export const layer = Layer.effect(DesktopAutoInstall, make);
