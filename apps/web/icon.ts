import { crc32, deflateSync } from 'node:zlib';

// The app icon (#121, D2), drawn at build time: no binary in git and no dependency. 512×512 on --bg, three stacked
// sector bars in --purple, --green and --fg, inside the maskable safe zone (a circle of radius 40 %: every corner
// here is under 196 px from the centre).

const SIZE = 512;
const BG = [0x15, 0x15, 0x1e];
const BARS: [width: number, rgb: number[]][] = [
  [320, [0xc4, 0x8c, 0xff]],
  [240, [0x3c, 0xcf, 0x6e]],
  [280, [0xf0, 0xf0, 0xf5]],
];

const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** The icon as an 8-bit RGB PNG. */
export function iconPng(): Buffer {
  const row = 1 + SIZE * 3;
  const raw = Buffer.alloc(row * SIZE); // each row's filter byte stays 0 (none)
  const fill = (x0: number, y0: number, x1: number, y1: number, rgb: number[]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) raw.set(rgb, y * row + 1 + x * 3);
  };
  fill(0, 0, SIZE, SIZE, BG);
  BARS.forEach(([width, rgb], i) => {
    fill(96, 144 + i * 84, 96 + width, 200 + i * 84, rgb);
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
