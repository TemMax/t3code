import {
  createProjectFaviconCache as createSharedProjectFaviconCache,
  createProjectFaviconImageLoader,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
  PROJECT_FAVICON_THUMBNAIL_SIZE,
  projectIconColorFromPixels,
  type ProjectFaviconEntry,
} from "@t3tools/client-runtime/project-favicon-cache";
import * as Effect from "effect/Effect";

import { decodePngRgba } from "./pngPixels";

import * as MobileDatabase from "../persistence/mobile-database";

const CACHE_KIND = "project-favicon";
const CACHE_SCHEMA_VERSION = 1;

let database: MobileDatabase.MobileDatabase["Service"] | undefined;

export function attachProjectFaviconDatabase(service: MobileDatabase.MobileDatabase["Service"]) {
  database = service;
}

const runDatabase = <A, E>(
  use: (database: MobileDatabase.MobileDatabase["Service"]) => Effect.Effect<A, E>,
) =>
  database
    ? Effect.runPromise(use(database))
    : Promise.reject(new Error("Project icon storage is not attached."));

/** expo-image encodes only through disk cache; remove the temporary frame after reading bytes. */
export async function downscaleProjectFavicon(
  image: { readonly url: string },
  signal: AbortSignal,
) {
  const [{ Image }, { File }] = await Promise.all([
    import("expo-image"),
    import("expo-file-system"),
  ]);
  for (const size of [PROJECT_FAVICON_THUMBNAIL_SIZE, PROJECT_FAVICON_THUMBNAIL_SIZE / 2]) {
    signal.throwIfAborted();
    const decoded = await Image.loadAsync(image.url, { maxWidth: size, maxHeight: size });
    const cacheKey = `t3-favicon-thumbnail:${size}:${image.url}`;
    try {
      signal.throwIfAborted();
      if (decoded.width > size || decoded.height > size) {
        throw new Error("Project icon was not resized.");
      }
      await Image.writeToCacheAsync(decoded, cacheKey);
      const path = await Image.getCachePathAsync(cacheKey);
      if (!path) throw new Error("Project icon thumbnail was not written.");
      const file = new File(path.startsWith("file:") ? path : `file://${path}`);
      try {
        if (file.size > PROJECT_FAVICON_MAX_DATA_URL_LENGTH) continue;
        const base64 = await file.base64();
        // SDWebImage chooses JPEG for opaque images and PNG for transparency; Glide always writes PNG.
        const mimeType = base64.startsWith("/9j/")
          ? "image/jpeg"
          : base64.startsWith("iVBORw0KGgo")
            ? "image/png"
            : null;
        if (!mimeType) throw new Error("Unsupported project icon thumbnail encoding.");
        const dataUrl = `data:${mimeType};base64,${base64}`;
        if (dataUrl.length <= PROJECT_FAVICON_MAX_DATA_URL_LENGTH) return dataUrl;
      } finally {
        file.delete();
      }
    } finally {
      decoded.release();
    }
  }
  throw new Error("Project icon thumbnail exceeds the cache limit.");
}

const COLOR_SAMPLE_SIZE = 16;

/** React Native cannot read pixels, so a 16px PNG re-encode is decoded in JS instead. */
async function readProjectFaviconColor(dataUrl: string, signal: AbortSignal) {
  const [{ ImageManipulator, SaveFormat }, { File }] = await Promise.all([
    import("expo-image-manipulator"),
    import("expo-file-system"),
  ]);
  const context = ImageManipulator.manipulate(dataUrl).resize({
    width: COLOR_SAMPLE_SIZE,
    height: COLOR_SAMPLE_SIZE,
  });
  try {
    const image = await context.renderAsync();
    try {
      signal.throwIfAborted();
      const saved = await image.saveAsync({ format: SaveFormat.PNG, base64: true });
      new File(saved.uri).delete();
      if (!saved.base64) throw new Error("Project icon sample has no pixels.");
      const pixels = decodePngRgba(Uint8Array.from(atob(saved.base64), (c) => c.charCodeAt(0)));
      return pixels ? projectIconColorFromPixels(pixels) : null;
    } finally {
      image.release();
    }
  } finally {
    context.release();
  }
}

export const projectFaviconDatabaseCache = createSharedProjectFaviconCache({
  storage: {
    list: () =>
      runDatabase((database) =>
        database.listCache(CACHE_KIND).pipe(
          Effect.map((payloads) =>
            payloads.flatMap((payload): Array<unknown> => {
              try {
                return [JSON.parse(payload)];
              } catch {
                return [];
              }
            }),
          ),
        ),
      ),
    put: (key, entry: ProjectFaviconEntry) =>
      runDatabase((database) =>
        database.saveCache(
          entry.environmentId,
          CACHE_KIND,
          key,
          CACHE_SCHEMA_VERSION,
          JSON.stringify(entry),
        ),
      ),
    remove: (key, entry) =>
      runDatabase((database) => database.removeCache(entry.environmentId, CACHE_KIND, key)),
  },
  load: createProjectFaviconImageLoader({ downscale: downscaleProjectFavicon }),
  readColor: readProjectFaviconColor,
});
