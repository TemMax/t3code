import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyServerConfigProjection,
  reuseUnchanged,
  withoutEnvironmentThemes,
} from "./serverConfigProjection.ts";

const encodeSettings = Schema.encodeSync(ServerSettings);
const decodeSettings = Schema.decodeSync(ServerSettings);

describe("reuseUnchanged", () => {
  const provider = (checkedAt: string, skills: ReadonlyArray<string>) => ({
    instanceId: "claude",
    checkedAt,
    models: [{ slug: "opus", name: "Opus" }],
    skills: skills.map((name) => ({ name })),
  });

  it("takes the new value when keys or lengths change", () => {
    const previous = [provider("a", ["x"])];
    const next = reuseUnchanged(previous, [provider("a", ["x", "z"])]);
    expect(next[0]!.skills).toHaveLength(2);
    expect(next[0]!.models).toBe(previous[0]!.models);
    const dropped = reuseUnchanged({ a: 1, b: 2 }, { a: 1 });
    expect(dropped).toEqual({ a: 1 });
  });
});

describe("applyServerConfigProjection settingsUpdated", () => {
  it("keeps unchanged settings sections when one field changes", () => {
    const settings = {
      favorites: [{ provider: "claude", model: "opus" }],
      providerInstances: {
        claude: { driver: "claudeAgent", config: { launchArgs: "" } },
        codex: { driver: "codex" },
      },
    };
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: {
        settings: {
          favorites: [{ provider: "claude", model: "opus" }],
          providerInstances: {
            claude: { driver: "claudeAgent", config: { launchArgs: "--verbose" } },
            codex: { driver: "codex" },
          },
        },
      },
    } as unknown as ServerConfigStreamEvent);
    const nextSettings = Option.getOrThrow(next).config.settings as unknown as typeof settings;
    expect(nextSettings.favorites).toBe(settings.favorites);
    expect(nextSettings.providerInstances.codex).toBe(settings.providerInstances.codex);
    expect(nextSettings.providerInstances.claude.config.launchArgs).toBe("--verbose");
  });

  it("keeps the settings object when an update repeats the current settings", () => {
    const wire = encodeSettings(DEFAULT_SERVER_SETTINGS);
    const decode = () => decodeSettings(structuredClone(wire));
    const settings = decode();
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: { settings: decode() },
    } as ServerConfigStreamEvent);
    expect(Option.getOrThrow(next).config).toBe(Option.getOrThrow(current).config);
  });
});

describe("applyServerConfigProjection clientProfile", () => {
  it("keeps the client profile out of snapshots and the cache and accumulates its updates", () => {
    const entry = (value: unknown) => ({ value, changedAt: 1, by: "device" });
    const update = (entries: Record<string, ReturnType<typeof entry>>, replace: boolean) =>
      ({
        version: 1,
        type: "clientProfileUpdated",
        payload: { entries, replace },
      }) as ServerConfigStreamEvent;
    const configOf = (projection: ReturnType<typeof applyServerConfigProjection>) =>
      Option.getOrThrow(projection).config;

    let current = Option.some({
      config: {} as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    current = applyServerConfigProjection(current, update({ a: entry(1) }, true)) as typeof current;
    expect(configOf(current).clientProfile).toEqual({ a: entry(1) });

    current = applyServerConfigProjection(
      current,
      update({ b: entry(2) }, false),
    ) as typeof current;
    expect(configOf(current).clientProfile).toEqual({ a: entry(1), b: entry(2) });

    const snapshot = applyServerConfigProjection(current, {
      version: 1,
      type: "snapshot",
      config: {},
    } as unknown as ServerConfigStreamEvent);
    expect(configOf(snapshot).clientProfile).toEqual({ a: entry(1), b: entry(2) });
    expect(withoutEnvironmentThemes(configOf(snapshot)).clientProfile).toBeUndefined();

    const cleared = applyServerConfigProjection(current, update({}, true));
    expect(configOf(cleared).clientProfile).toEqual({});
  });
});

describe("applyServerConfigProjection environmentThemes", () => {
  it("keeps an empty theme list as the server's answer", () => {
    const themesUpdated = (themes: unknown[]) =>
      ({
        version: 1,
        type: "environmentThemesUpdated",
        payload: { themes },
      }) as unknown as ServerConfigStreamEvent;
    const snapshotEvent = {
      version: 1,
      type: "snapshot",
      config: {},
    } as unknown as ServerConfigStreamEvent;
    const configOf = (projection: ReturnType<typeof applyServerConfigProjection>) =>
      Option.getOrThrow(projection).config;

    let current = applyServerConfigProjection(Option.none(), snapshotEvent);
    expect(configOf(current).environmentThemes).toBeUndefined();

    const theme = { id: "night" };
    current = applyServerConfigProjection(current, themesUpdated([theme]));
    expect(configOf(current).environmentThemes).toEqual([theme]);

    current = applyServerConfigProjection(current, themesUpdated([]));
    expect(configOf(current).environmentThemes).toEqual([]);

    current = applyServerConfigProjection(current, snapshotEvent);
    expect(configOf(current).environmentThemes).toEqual([]);
  });
});
