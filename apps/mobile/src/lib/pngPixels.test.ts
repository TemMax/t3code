import { zlibSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";

import { decodePngRgba } from "./pngPixels";

function chunk(type: string, data: Uint8Array) {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(
    Array.from(type, (character) => character.charCodeAt(0)),
    4,
  );
  bytes.set(data, 8);
  return bytes;
}

function png(input: {
  width: number;
  height: number;
  colorType: number;
  bitDepth?: number;
  rows: ReadonlyArray<readonly number[]>;
}) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, input.width);
  view.setUint32(4, input.height);
  header[8] = input.bitDepth ?? 8;
  header[9] = input.colorType;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(new Uint8Array(input.rows.flat()))),
    chunk("IEND", new Uint8Array()),
  ];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

describe("decodePngRgba", () => {
  it("reverses every scanline filter in an RGBA image", () => {
    // Pixels: row 0 = (10,20,30,255) (40,60,80,255); row 1 = (15,25,35,255) (50,70,90,128).
    const decoded = decodePngRgba(
      png({
        width: 2,
        height: 2,
        colorType: 6,
        rows: [
          [1, 10, 20, 30, 255, 30, 40, 50, 0],
          [4, 5, 5, 5, 0, 10, 10, 10, 129],
        ],
      }),
    );
    expect(decoded && Array.from(decoded)).toEqual([
      10, 20, 30, 255, 40, 60, 80, 255, 15, 25, 35, 255, 50, 70, 90, 128,
    ]);

    const averaged = decodePngRgba(
      png({
        width: 1,
        height: 2,
        colorType: 6,
        rows: [
          [0, 100, 100, 100, 255],
          [3, 10, 20, 30, 0],
        ],
      }),
    );
    expect(averaged && Array.from(averaged)).toEqual([100, 100, 100, 255, 60, 70, 80, 127]);
  });

  it("expands RGB to opaque RGBA and refuses layouts it does not read", () => {
    const rgb = decodePngRgba(png({ width: 1, height: 1, colorType: 2, rows: [[2, 9, 8, 7]] }));
    expect(rgb && Array.from(rgb)).toEqual([9, 8, 7, 255]);
    expect(decodePngRgba(png({ width: 1, height: 1, colorType: 3, rows: [[0, 0]] }))).toBeNull();
    expect(
      decodePngRgba(png({ width: 1, height: 1, colorType: 6, bitDepth: 16, rows: [[0]] })),
    ).toBeNull();
    expect(decodePngRgba(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
