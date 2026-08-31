import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS, processingPlan, resizedDimensions, resizedName, resolvedPlan, validateOptions } from '../src/model.ts';
import type { ProcessingOptions, VideoInfo } from '../src/model.ts';

const info: VideoInfo = { width: 3840, height: 2160, duration: 1200, codec: 'avc', audioTracks: 2, parts: [], needsSplit: true };
const source = { name: '2026.가족 여행.MOV', size: 900_000_000 };

test('orientation-aware resolution boxes preserve landscape, portrait and square videos', () => {
  assert.deepEqual(resizedDimensions(3840, 2160, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(resizedDimensions(3840, 2160, 720), { width: 1280, height: 720 });
  assert.deepEqual(resizedDimensions(2160, 3840, 1080), { width: 1080, height: 1920 });
  assert.deepEqual(resizedDimensions(2160, 3840, 480), { width: 480, height: 852 });
  assert.deepEqual(resizedDimensions(2000, 2000, 720), { width: 720, height: 720 });
  assert.deepEqual(resizedDimensions(4000, 1000, 1080), { width: 1920, height: 480 });
});

test('smaller videos, original mode and odd-sized no-op videos are never enlarged or re-encoded', () => {
  assert.deepEqual(resizedDimensions(640, 360, 720), { width: 640, height: 360 });
  assert.deepEqual(resizedDimensions(721, 405, 1080), { width: 721, height: 405 });
  assert.deepEqual(resizedDimensions(3840, 2160, 'original'), { width: 3840, height: 2160 });
  const plan = processingPlan(source, { ...info, width: 640, height: 360 }, { mode: 'resize', resolution: 720 });
  assert.equal(plan.reencode, false);
  assert.equal(plan.awaitingSize, false);
  assert.equal(plan.parts[0].name, source.name);
  assert.equal(plan.parts.length, 1, 'resize-only never splits even a large original');
});

test('downsized dimensions are even, fit the maximum box and approximate the original aspect ratio', () => {
  for (const [width, height] of [[1921, 1081], [1081, 1921], [4000, 1000], [1000, 4000]]) {
    for (const resolution of [1080, 720, 480] as const) {
      const output = resizedDimensions(width, height, resolution);
      assert.ok(output.width <= width && output.height <= height);
      assert.equal(output.width % 2, 0);
      assert.equal(output.height % 2, 0);
      assert.ok(Math.min(output.width, output.height) <= resolution);
      assert.ok(Math.abs(output.width / output.height - width / height) < 0.04);
    }
  }
  for (const dimension of [0, -1, NaN, Infinity]) assert.throws(() => resizedDimensions(dimension, 1080, 720));
  assert.throws(() => validateOptions({ mode: 'other', resolution: 720 } as unknown as ProcessingOptions));
  assert.throws(() => validateOptions({ mode: 'resize', resolution: 999 } as unknown as ProcessingOptions));
});

test('split-only stays lossless and calculates the original equal-time plan', () => {
  assert.deepEqual(DEFAULT_OPTIONS, { mode: 'split', resolution: 'original' });
  const plan = processingPlan(source, info, { mode: 'split', resolution: 720 });
  assert.equal(plan.options.resolution, 'original');
  assert.equal(plan.reencode, false);
  assert.equal(plan.parts.length, 4);
  assert.equal(plan.parts[0].name, '2026.가족 여행_1of4.mp4');
  assert.equal(plan.parts[0].end, 300);
});

test('resize then split waits for the actual converted size, not the original or bitrate estimate', () => {
  const plan = processingPlan(source, info, { mode: 'resize-split', resolution: 720 });
  assert.equal(plan.awaitingSize, true);
  assert.deepEqual(plan.parts, []);
  assert.equal(plan.outputWidth, 1280);
  // Tiny test units avoid allocating a 400 MB file in a unit test.
  const converted = new File([new Uint8Array(400)], resizedName(source.name));
  const ready = resolvedPlan(plan, converted, { ...info, width: 1280, height: 720 }, 250);
  assert.equal(ready.awaitingSize, false);
  assert.equal(ready.convertedBytes, 400);
  assert.equal(ready.parts.length, 2);
  assert.equal(ready.parts[0].name, '2026.가족 여행_1of2.mp4');
  assert.equal(ready.parts[1].start, 600);
  assert.equal(ready.parts[1].end, 1200);
});

test('resize-only keeps the base name and has exactly one output with unknown size until completion', () => {
  const plan = processingPlan(source, info, { mode: 'resize', resolution: 480 });
  assert.equal(plan.reencode, true);
  assert.equal(plan.awaitingSize, true);
  assert.equal(plan.parts.length, 1);
  assert.equal(plan.parts[0].name, '2026.가족 여행.mp4');
  assert.equal(plan.parts[0].estimatedBytes, 0);
  assert.equal(resizedName('no-extension'), 'no-extension.mp4');
  assert.equal(resizedName('원본.MP4'), '원본.mp4');
  const small = new File([new Uint8Array(100)], '원본.mp4');
  const ready = resolvedPlan({ ...plan, options: { mode: 'resize-split', resolution: 480 } }, small, info, 250);
  assert.equal(ready.parts.length, 1);
  assert.equal(ready.parts[0].name, '원본.mp4');
});
