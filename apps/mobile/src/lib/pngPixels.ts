import { unzlibSync } from "fflate";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS_BY_COLOR_TYPE: Partial<Record<number, number>> = { 2: 3, 6: 4 };

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

/**
 * Decodes the 8-bit RGB or RGBA, non-interlaced PNGs that image manipulators write into RGBA
 * pixels. Returns null for any other layout rather than guessing.
 */
export function decodePngRgba(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels: number | undefined;
  const chunks: Array<Uint8Array> = [];
  let compressedLength = 0;
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const bitDepth = data[8];
      const interlace = data[12];
      channels = CHANNELS_BY_COLOR_TYPE[data[9] ?? -1];
      if (bitDepth !== 8 || interlace !== 0 || channels === undefined) return null;
    } else if (type === "IDAT") {
      chunks.push(data);
      compressedLength += data.length;
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (channels === undefined || width === 0 || height === 0 || chunks.length === 0) return null;

  const compressed = new Uint8Array(compressedLength);
  let position = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, position);
    position += chunk.length;
  }
  const filtered = unzlibSync(compressed);
  const stride = width * channels;
  if (filtered.length < height * (stride + 1)) return null;

  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[source + x] ?? 0;
      const left = x >= channels ? (rows[row + x - channels] ?? 0) : 0;
      const up = y > 0 ? (rows[row - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (rows[row - stride + x - channels] ?? 0) : 0;
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth(left, up, upLeft)
                : 0;
      rows[row + x] = (raw + predictor) & 0xff;
    }
  }
  if (channels === 4) return rows;

  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = rows[pixel * 3] ?? 0;
    rgba[pixel * 4 + 1] = rows[pixel * 3 + 1] ?? 0;
    rgba[pixel * 4 + 2] = rows[pixel * 3 + 2] ?? 0;
    rgba[pixel * 4 + 3] = 255;
  }
  return rgba;
}
