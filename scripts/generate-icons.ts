// Rasterize only the simple geometry of our existing favicon, using Node built-ins.
// PNGs are checked in; CI regenerates them without an external renderer, network, or child process.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

type Color = readonly [number, number, number];
interface Rect { x: number; y: number; width: number; height: number; radius: number; color: Color }
const svg = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8');
assert.match(svg, /viewBox="0 0 64 64"/);
const attribute = (tag: string, name: string) => tag.match(new RegExp(`(?:^|\\s)${name}="([^"]+)"`))?.[1];
function color(value: string | undefined): Color {
  if (value === 'white') return [255, 255, 255];
  assert.match(value ?? '', /^#[0-9a-f]{6}$/i);
  return [1, 3, 5].map(start => Number.parseInt(value!.slice(start, start + 2), 16)) as unknown as Color;
}
const rects: Rect[] = [...svg.matchAll(/<rect\b[^>]*\/>/g)].map(([tag]) => ({
  x: Number(attribute(tag, 'x') ?? 0), y: Number(attribute(tag, 'y') ?? 0),
  width: Number(attribute(tag, 'width')), height: Number(attribute(tag, 'height')),
  radius: Number(attribute(tag, 'rx') ?? 0), color: color(attribute(tag, 'fill')),
}));
assert.equal(rects.length, 3, 'Update the icon renderer if the favicon geometry changes.');
assert.equal(rects[0].width, 64); assert.equal(rects[0].height, 64);
const divider = svg.match(/<path\b[^>]*\/>/)?.[0] ?? '';
assert.equal(attribute(divider, 'd'), 'M32 12v40');
assert.equal(attribute(divider, 'stroke-width'), '2');
assert.equal(attribute(divider, 'stroke-dasharray'), '3 4');
const dividerColor = color(attribute(divider, 'stroke'));

function contains(rect: Rect, x: number, y: number, radius = rect.radius): boolean {
  if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) return false;
  const cx = Math.max(rect.x + radius, Math.min(x, rect.x + rect.width - radius));
  const cy = Math.max(rect.y + radius, Math.min(y, rect.y + rect.height - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}
function sample(x: number, y: number, opaque: boolean): Color | undefined {
  let pixel = contains(rects[0], x, y, opaque ? 0 : rects[0].radius) ? rects[0].color : undefined;
  for (const rect of rects.slice(1)) if (contains(rect, x, y)) pixel = rect.color;
  if (x >= 31 && x < 33 && y >= 12 && y < 52 && (y - 12) % 7 < 3) pixel = dividerColor;
  return pixel;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}
function render(size: number, opaque: boolean): Buffer {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride); // Each row starts with PNG filter 0.
  const grid = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let covered = 0, red = 0, green = 0, blue = 0;
    for (let sy = 0; sy < grid; sy++) for (let sx = 0; sx < grid; sx++) {
      const pixel = sample((x + (sx + .5) / grid) * 64 / size, (y + (sy + .5) / grid) * 64 / size, opaque);
      if (pixel) { covered++; red += pixel[0]; green += pixel[1]; blue += pixel[2]; }
    }
    const offset = y * stride + 1 + x * 4;
    if (covered) raw.set([Math.round(red / covered), Math.round(green / covered), Math.round(blue / covered), Math.round(255 * covered / (grid * grid))], offset);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA, non-interlaced.
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

const directory = new URL('../public/icons/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, size, opaque] of [
  ['icon-192.png', 192, false], ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true],
] as const) {
  await writeFile(new URL(name, directory), render(size, opaque));
  console.log(`Generated ${name}: ${size}x${size}`);
}
