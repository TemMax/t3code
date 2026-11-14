import { EnvironmentId, ProjectIconColor } from "@t3tools/contracts";
import { mediaMimeType } from "@t3tools/shared/mediaPreview";
import {
  getProjectFaviconCacheKey,
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const PROJECT_FAVICON_THUMBNAIL_SIZE = 96;
export const PROJECT_FAVICON_MAX_DATA_URL_LENGTH = 32 * 1024;
export const PROJECT_FAVICON_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const PROJECT_FAVICON_CACHE_MAX_BYTES = 1024 * 1024;
export const PROJECT_FAVICON_CACHE_MAX_ENTRIES = 128;

export interface ProjectFaviconTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
}

const ImageDataUrl = Schema.String.check(
  Schema.isMaxLength(PROJECT_FAVICON_MAX_DATA_URL_LENGTH),
  Schema.isPattern(
    /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/,
  ),
);
const Entry = Schema.Struct({
  environmentId: EnvironmentId,
  cwd: Schema.String,
  faviconPath: Schema.NullOr(Schema.String),
  revision: Schema.String,
  dataUrl: ImageDataUrl,
  // Absent until the colour is read, so a failed read retries from the cached image.
  color: Schema.optionalKey(Schema.NullOr(ProjectIconColor)),
});
export type ProjectFaviconEntry = typeof Entry.Type;
const decodeEntry = Schema.decodeUnknownOption(Entry);
const isImageDataUrl = Schema.is(ImageDataUrl);

function keyFor(target: ProjectFaviconTarget) {
  return getProjectFaviconResourceKey(target.environmentId, target.cwd, target.faviconPath);
}

// A favicon's dominant hue snaps to the nearest monogram swatch, so a project title never
// takes a raw image colour and every tint comes from one palette tuned for contrast.
const PALETTE_SWATCHES = [
  ["red", 0xef4444],
  ["orange", 0xf97316],
  ["amber", 0xf59e0b],
  ["yellow", 0xeab308],
  ["lime", 0x84cc16],
  ["green", 0x22c55e],
  ["emerald", 0x10b981],
  ["teal", 0x14b8a6],
  ["cyan", 0x06b6d4],
  ["sky", 0x0ea5e9],
  ["blue", 0x3b82f6],
  ["indigo", 0x6366f1],
  ["violet", 0x8b5cf6],
  ["purple", 0xa855f7],
  ["fuchsia", 0xd946ef],
  ["pink", 0xec4899],
  ["rose", 0xf43f5e],
] as const satisfies ReadonlyArray<readonly [ProjectIconColor, number]>;
const MIN_CHROMA = 48;
const MIN_COLORFUL_SHARE = 0.08;
const HUE_BINS = 36;

function hueOf(r: number, g: number, b: number, max: number, chroma: number) {
  const sector =
    max === r
      ? (g - b) / chroma + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / chroma + 2
        : (r - g) / chroma + 4;
  return sector * 60;
}

const SWATCH_HUES = PALETTE_SWATCHES.map(([color, hex]) => {
  const r = hex >> 16;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const max = Math.max(r, g, b);
  return [color, hueOf(r, g, b, max, max - Math.min(r, g, b))] as const;
});

/**
 * Picks the palette colour of an icon's dominant hue from RGBA pixels, or null when the icon
 * is mostly transparent, black, white, or gray and its project title should stay neutral.
 */
export function projectIconColorFromPixels(rgba: ArrayLike<number>): ProjectIconColor | null {
  const weights = new Float64Array(HUE_BINS);
  const cosines = new Float64Array(HUE_BINS);
  const sines = new Float64Array(HUE_BINS);
  let opaque = 0;
  let colorful = 0;
  for (let index = 0; index + 3 < rgba.length; index += 4) {
    if ((rgba[index + 3] ?? 0) < 128) continue;
    opaque += 1;
    const r = rgba[index] ?? 0;
    const g = rgba[index + 1] ?? 0;
    const b = rgba[index + 2] ?? 0;
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    if (chroma < MIN_CHROMA) continue;
    colorful += 1;
    const hue = hueOf(r, g, b, max, chroma);
    const bin = Math.floor(hue / (360 / HUE_BINS)) % HUE_BINS;
    const radians = (hue * Math.PI) / 180;
    weights[bin]! += chroma;
    cosines[bin]! += chroma * Math.cos(radians);
    sines[bin]! += chroma * Math.sin(radians);
  }
  if (opaque === 0 || colorful / opaque < MIN_COLORFUL_SHARE) return null;

  const around = (bin: number) => [(bin + HUE_BINS - 1) % HUE_BINS, bin, (bin + 1) % HUE_BINS];
  let peak = 0;
  let peakWeight = -1;
  for (let bin = 0; bin < HUE_BINS; bin += 1) {
    const weight = around(bin).reduce((sum, neighbor) => sum + weights[neighbor]!, 0);
    if (weight > peakWeight) {
      peak = bin;
      peakWeight = weight;
    }
  }
  const [cos, sin] = around(peak).reduce(
    ([cosSum, sinSum], neighbor) => [cosSum + cosines[neighbor]!, sinSum + sines[neighbor]!],
    [0, 0],
  );
  const hue = ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360;
  let nearest: ProjectIconColor = "blue";
  let nearestDistance = Infinity;
  for (const [color, swatchHue] of SWATCH_HUES) {
    const delta = Math.abs(hue - swatchHue);
    const distance = Math.min(delta, 360 - delta);
    if (distance < nearestDistance) {
      nearest = color;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export interface ProjectFaviconStorage {
  readonly list: () => Promise<ReadonlyArray<unknown>>;
  readonly put: (key: string, entry: ProjectFaviconEntry) => Promise<void>;
  readonly remove: (key: string, entry: ProjectFaviconEntry) => Promise<void>;
}

async function readBounded(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Project icon is too large to decode.");
  }
  if (!response.body) {
    const bytes = new Uint8Array<ArrayBuffer>(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Project icon is too large to decode.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Project icon is too large to decode.");
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array<ArrayBuffer>(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Larger bitmaps go through the platform downscaler; larger SVGs stay remote because rasterizing
 * them without intrinsic dimensions is unreliable.
 */
export function createProjectFaviconImageLoader(input: {
  readonly fetch?: typeof fetch;
  readonly downscale: (
    image: {
      readonly url: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array<ArrayBuffer>;
    },
    signal: AbortSignal,
  ) => Promise<string>;
}) {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  return async (url: string, signal: AbortSignal): Promise<string> => {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`Project icon request failed with ${response.status}.`);
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const mimeType = contentType?.startsWith("image/") ? contentType : mediaMimeType(url);
    if (!mimeType) throw new Error("Project icon has no image type.");
    const bytes = await readBounded(response, PROJECT_FAVICON_MAX_SOURCE_BYTES);
    signal.throwIfAborted();
    const dataUrl = `data:${mimeType};base64,${Base64.encode(bytes)}`;
    if (isImageDataUrl(dataUrl)) return dataUrl;
    if (mimeType === "image/svg+xml") throw new Error("Project icon exceeds the cache limit.");
    return input.downscale({ url, mimeType, bytes }, signal);
  };
}

export function createProjectFaviconCache(input: {
  readonly storage: ProjectFaviconStorage;
  readonly load: (url: string, signal: AbortSignal) => Promise<string>;
  /** Decodes a cached data URL and returns `projectIconColorFromPixels` of it. */
  readonly readColor: (dataUrl: string, signal: AbortSignal) => Promise<ProjectIconColor | null>;
}) {
  const entries = new Map<string, ProjectFaviconEntry>();
  const environmentRevisions = new Map<EnvironmentId, number>();
  let generation = 0;
  let hydration: Promise<void> | undefined;
  let clearing: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();

  const persist = (operation: () => Promise<void>) => {
    const task: Promise<void> = operation()
      .catch(() => {})
      .finally(() => pending.delete(task));
    pending.add(task);
  };

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    persist(() => input.storage.remove(key, entry));
  };

  const trim = () => {
    let bytes = 0;
    for (const entry of entries.values()) bytes += entry.dataUrl.length;
    while (
      entries.size > PROJECT_FAVICON_CACHE_MAX_ENTRIES ||
      bytes > PROJECT_FAVICON_CACHE_MAX_BYTES
    ) {
      const oldest = entries.entries().next().value;
      if (!oldest) break;
      bytes -= oldest[1].dataUrl.length;
      remove(oldest[0]);
    }
  };

  const hydrate = () =>
    (hydration ??= (async () => {
      try {
        for (const record of await input.storage.list()) {
          const entry = decodeEntry(record);
          if (Option.isSome(entry)) entries.set(keyFor(entry.value), entry.value);
        }
        trim();
      } catch {}
    })());

  const peek = (target: ProjectFaviconTarget) => entries.get(keyFor(target))?.dataUrl ?? null;
  const peekColor = (target: ProjectFaviconTarget) => entries.get(keyFor(target))?.color ?? null;

  const resolve = async (
    target: ProjectFaviconTarget,
    url: string | null,
    signal: AbortSignal,
  ): Promise<string | null> => {
    await clearing;
    const startGeneration = generation;
    const startRevision = environmentRevisions.get(target.environmentId) ?? 0;
    await hydrate();
    if (signal.aborted || url === null) return peek(target);
    const key = keyFor(target);
    if (isProjectFaviconFallbackUrl(url)) {
      remove(key);
      return null;
    }
    const revision = getProjectFaviconCacheKey(target.environmentId, target.cwd, url);
    const stale = () =>
      signal.aborted ||
      startGeneration !== generation ||
      startRevision !== (environmentRevisions.get(target.environmentId) ?? 0);
    const store = (entry: ProjectFaviconEntry) => {
      entries.set(key, entry);
      persist(() => input.storage.put(key, entry));
      trim();
    };
    const readColor = (dataUrl: string) =>
      input.readColor(dataUrl, signal).then(
        (color) => ({ color }),
        () => ({}),
      );
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      if (cached.revision === revision) {
        if (cached.color !== undefined) return cached.dataUrl;
        const color = await readColor(cached.dataUrl);
        if (!stale() && entries.get(key) === cached && "color" in color) {
          store({ ...cached, ...color });
        }
        return peek(target);
      }
    }
    try {
      const dataUrl = await input.load(url, signal);
      const color = isImageDataUrl(dataUrl) ? await readColor(dataUrl) : {};
      if (stale()) return peek(target);
      if (isImageDataUrl(dataUrl)) {
        store({
          environmentId: target.environmentId,
          cwd: target.cwd,
          faviconPath: target.faviconPath || null,
          revision,
          dataUrl,
          ...color,
        });
        return dataUrl;
      }
    } catch {}
    return peek(target) ?? url;
  };

  const flush = async () => {
    await Promise.all(pending);
  };

  // A download that started before the clear sees the revision change and is discarded;
  // one that starts during the clear waits for it, so it cannot repopulate storage.
  const clear = async (environmentId?: EnvironmentId) => {
    if (environmentId === undefined) generation += 1;
    else
      environmentRevisions.set(environmentId, (environmentRevisions.get(environmentId) ?? 0) + 1);
    const previous = clearing;
    const task = (async () => {
      await previous;
      await hydrate();
      for (const [key, entry] of entries) {
        if (environmentId === undefined || entry.environmentId === environmentId) remove(key);
      }
      await flush();
    })().finally(() => {
      if (clearing === task) clearing = undefined;
    });
    clearing = task;
    await task;
  };

  return {
    hydrate,
    peek,
    peekColor,
    resolve,
    clearEnvironment: (environmentId: EnvironmentId) => clear(environmentId),
    clearAll: () => clear(),
    flush,
  };
}

export type ProjectFaviconCache = ReturnType<typeof createProjectFaviconCache>;
