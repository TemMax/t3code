import { assert, describe, it } from "@effect/vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  AGENT_ACTIVITY_REPORT_TTL_MS,
  AUTO_INSTALL_MIN_SYSTEM_IDLE_SECONDS,
  type AutoInstallInput,
  nextAutoInstallStep,
} from "./DesktopAutoInstall.ts";

const NOW = 1_000_000_000;

function makeState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "downloaded",
    channel: "latest",
    currentVersion: "0.1.6",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.1.7",
    downloadedVersion: "0.1.7",
    releaseNotes: [],
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    omittedReleaseCount: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<AutoInstallInput> = {}): AutoInstallInput {
  return {
    enabled: true,
    state: makeState(),
    reports: [{ busy: false, reportedAtMs: NOW }],
    nowMs: NOW,
    systemIdleSeconds: AUTO_INSTALL_MIN_SYSTEM_IDLE_SECONDS,
    attemptedVersions: new Set(),
    ...overrides,
  };
}

describe("nextAutoInstallStep", () => {
  it("installs a downloaded update when agents and the user are idle", () => {
    assert.deepStrictEqual(nextAutoInstallStep(makeInput()), {
      action: "install",
      version: "0.1.7",
    });
  });

  it("downloads an available update without waiting for idle", () => {
    const step = nextAutoInstallStep(
      makeInput({
        state: makeState({ status: "available", downloadedVersion: null }),
        reports: [{ busy: true, reportedAtMs: NOW }],
        systemIdleSeconds: 0,
      }),
    );
    assert.deepStrictEqual(step, { action: "download" });
  });

  const waits: ReadonlyArray<readonly [string, Partial<AutoInstallInput>]> = [
    ["the setting is off", { enabled: false }],
    ["the updater is disabled", { state: makeState({ enabled: false, status: "disabled" }) }],
    [
      "a window reports busy agents",
      {
        reports: [
          { busy: false, reportedAtMs: NOW },
          { busy: true, reportedAtMs: NOW },
        ],
      },
    ],
    ["no window has reported", { reports: [] }],
    [
      "every report is stale",
      {
        reports: [{ busy: false, reportedAtMs: NOW - AGENT_ACTIVITY_REPORT_TTL_MS - 1 }],
      },
    ],
    [
      "the user was active recently",
      { systemIdleSeconds: AUTO_INSTALL_MIN_SYSTEM_IDLE_SECONDS - 1 },
    ],
    ["the version did not apply before", { state: makeState({ notAppliedVersion: "0.1.7" }) }],
    ["this session already tried the version", { attemptedVersions: new Set(["0.1.7"]) }],
    ["the last install failed", { state: makeState({ status: "error", errorContext: "install" }) }],
    [
      "a download is in progress",
      { state: makeState({ status: "downloading", downloadedVersion: null }) },
    ],
  ];
  it.each(waits)("waits when %s", (_reason, overrides) => {
    assert.deepStrictEqual(nextAutoInstallStep(makeInput(overrides)), { action: "wait" });
  });

  it("ignores a stale busy report from a closed window", () => {
    const step = nextAutoInstallStep(
      makeInput({
        reports: [
          { busy: true, reportedAtMs: NOW - AGENT_ACTIVITY_REPORT_TTL_MS - 1 },
          { busy: false, reportedAtMs: NOW },
        ],
      }),
    );
    assert.deepStrictEqual(step, { action: "install", version: "0.1.7" });
  });
});
