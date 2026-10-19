import { crc32, deflateSync } from "node:zlib";

const SIZE = 180;
const SAMPLES = 4;
const RADIUS = 40;
const CENTER = SIZE / 2;
const RING_OUTER = 33;
const RING_INNER = 22;
const RING_OFFSET = 22;

type Rgb = readonly [number, number, number];
type Layer = { color: Rgb; covers: (x: number, y: number) => boolean };

const ring = (cx: number, cy: number, x: number, y: number): boolean => {
  const d = Math.hypot(x - cx, y - cy);
  return d <= RING_OUTER && d >= RING_INNER;
};

const roundedSquare = (x: number, y: number): boolean => {
  const dx = Math.max(RADIUS - x, x - (SIZE - RADIUS), 0);
  const dy = Math.max(RADIUS - y, y - (SIZE - RADIUS), 0);
  return Math.hypot(dx, dy) <= RADIUS;
};

const LAYERS: readonly Layer[] = [
  { color: [21, 26, 34], covers: roundedSquare },
  { color: [123, 156, 247], covers: (x, y) => ring(CENTER - RING_OFFSET, CENTER, x, y) },
  { color: [233, 236, 241], covers: (x, y) => ring(CENTER + RING_OFFSET, CENTER, x, y) },
  { color: [123, 156, 247], covers: (x, y) => y < CENTER && ring(CENTER - RING_OFFSET, CENTER, x, y) },
];

function pixel(px: number, py: number): [number, number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = px + (sx + 0.5) / SAMPLES;
      const y = py + (sy + 0.5) / SAMPLES;
      const top = LAYERS.findLast((layer) => layer.covers(x, y));
      if (!top) continue;
      r += top.color[0];
      g += top.color[1];
      b += top.color[2];
      a++;
    }
  }
  if (a === 0) return [0, 0, 0, 0];
  return [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((255 * a) / (SAMPLES * SAMPLES))];
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

let cached: Buffer | undefined;

export function iconPng(): Buffer {
  cached ??= render();
  return Buffer.from(cached);
}

function render(): Buffer {
  const stride = 1 + SIZE * 4;
  const raw = Buffer.alloc(stride * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = y * stride;
    for (let x = 0; x < SIZE; x++) raw.set(pixel(x, y), row + 1 + x * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
