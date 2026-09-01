import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

test('manifest identity, start URL, and scope belong to this GitHub Pages project', async () => {
  const manifest = JSON.parse(await read('public/manifest.webmanifest'));
  const url = 'https://smrmdkqo-afk.github.io/video-splitter/manifest.webmanifest';
  const start = new URL(manifest.start_url, url);
  const scope = new URL(manifest.scope, url);
  // Per the manifest spec, a relative id resolves against the start URL's ORIGIN.
  const identity = new URL(manifest.id, start.origin);
  assert.equal(identity.href, 'https://smrmdkqo-afk.github.io/video-splitter/');
  assert.equal(start.href, identity.href); assert.equal(scope.href, identity.href);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  assert.equal(manifest.lang, 'ko'); assert.equal(manifest.name, 'Video Splitter');
  assert.equal(manifest.theme_color, '#f6f8fc');
  assert.equal(identity.search, ''); assert.equal(identity.hash, '');
});

function decodePng(bytes: Buffer) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 8); assert.equal(bytes[25], 6);
  const compressed: Buffer[] = [];
  let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + size);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + size)) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32BE(offset + 8 + size), `${type} checksum`);
    if (type === 'IDAT') compressed.push(body);
    if (type === 'IEND') { ended = true; assert.equal(offset + size + 12, bytes.length); }
    offset += size + 12;
  }
  assert.equal(ended, true);
  const rgba = inflateSync(Buffer.concat(compressed));
  const stride = width * 4 + 1;
  assert.equal(rgba.length, stride * height);
  for (let y = 0; y < height; y++) assert.equal(rgba[y * stride], 0);
  return { width, height, pixel: (x: number, y: number) => [...rgba.subarray(y * stride + x * 4 + 1, y * stride + x * 4 + 5)] };
}

test('all manifest icons and Apple icon are complete PNGs with the declared sizes', async () => {
  const manifest = JSON.parse(await read('public/manifest.webmanifest'));
  assert.deepEqual(manifest.icons.map((icon: { sizes: string; purpose: string }) => [icon.sizes, icon.purpose]), [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]);
  const icons = [...manifest.icons, { src: './icons/apple-touch-icon.png', sizes: '180x180', purpose: 'apple', type: 'image/png' }];
  for (const icon of icons) {
    assert.equal(icon.type, 'image/png');
    const png = decodePng(await readFile(new URL(`public/${icon.src}`, root)));
    assert.equal(`${png.width}x${png.height}`, icon.sizes);
    const scale = png.width / 64;
    assert.deepEqual(png.pixel(Math.floor(20 * scale), Math.floor(30 * scale)), [255, 255, 255, 255]);
    assert.deepEqual(png.pixel(Math.floor(42 * scale), Math.floor(30 * scale)), [255, 255, 255, 255]);
    if (icon.purpose === 'maskable' || icon.purpose === 'apple') {
      assert.deepEqual(png.pixel(0, 0), [39, 96, 232, 255]);
      for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) assert.equal(png.pixel(x, y)[3], 255, 'full-bleed icons must be opaque');
    } else assert.equal(png.pixel(0, 0)[3], 0);
    if (icon.purpose === 'maskable') {
      for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
        if (Math.hypot(x + .5 - png.width / 2, y + .5 - png.height / 2) > png.width * .4) {
          assert.deepEqual(png.pixel(x, y), [39, 96, 232, 255], 'logo stays inside the maskable safe circle');
        }
      }
    }
  }
});

test('HTML references install assets inside the project and release versions agree', async () => {
  const html = await read('index.html');
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\.\/icons\/apple-touch-icon\.png"/);
  const pkg = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(pkg.version, '1.3.0');
  assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
  assert.ok((await read('src/main.ts')).includes(`v${pkg.version}`));
  assert.ok((await read('README.md')).includes(`v${pkg.version}`));
});

test('install integration retains work safeguards and contains no file mutation or forced navigation', async () => {
  const main = await read('src/main.ts');
  assert.match(main, /const workLocked = \(\) => processing \|\| inspecting \|\| !!installUI\?\.prompting/);
  assert.match(main, /temporaryResults: jobs\.some\(job => job\.results\.some\(result => !result\.original\)\)/);
  const ui = await read('src/install-ui.ts');
  assert.match(ui, /aria-labelledby/); assert.match(ui, /dialog\.showModal\(\)/);
  assert.match(ui, /'beforeinstallprompt'/); assert.match(ui, /'appinstalled'/);
  const install = ui + await read('src/pwa.ts');
  assert.doesNotMatch(install, /navigator\.serviceWorker|caches\.open|localStorage|sessionStorage|location\.(?:assign|replace|reload)\s*\(|location\.href\s*=|bridge\.request|removeEntry|createWritable/);
  assert.doesNotMatch(await read('scripts/generate-icons.ts'), /child_process|execFile|spawn\(|https?:\/\/|fetch\(/);
});
