import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCount, makePlan, outputName, formatBytes, formatTime, formatEta, escapeHtml, errorMessage, ReencodeRequiredError, TARGET_BYTES } from '../src/model.ts';
import { makeSizePlan } from '../src/engine.ts';

test('250 MB means decimal bytes, and only controls the piece count', () => {
  assert.equal(TARGET_BYTES, 250_000_000);
  assert.equal(splitCount(1), 1);
  assert.equal(splitCount(TARGET_BYTES), 1);
  assert.equal(splitCount(TARGET_BYTES + 1), 2);
  assert.equal(splitCount(1_000_000_000), 4);
  assert.equal(splitCount(1_000_000_001), 5);
});

test('pieces cover the duration once, with equal planned durations', () => {
  const plan = makePlan('가족 여행.MOV', 820_000_000, 243.7);
  assert.equal(plan.length, 4);
  assert.equal(plan[0].start, 0);
  assert.equal(plan.at(-1)!.end, 243.7);
  plan.forEach((part, i) => {
    assert.ok(Math.abs(part.end - part.start - 243.7 / 4) < 1e-10);
    assert.equal(part.name, `가족 여행_${i + 1}of4.mp4`);
    assert.equal(part.estimatedBytes, 205_000_000);
    if (i) assert.equal(part.start, plan[i - 1].end);
  });
});

test('small videos keep their exact original filename', () => {
  assert.deepEqual(makePlan('원본.MOV', 200_000_000, 37), [{ index: 1, name: '원본.MOV', start: 0, end: 37, estimatedBytes: 200_000_000 }]);
});

test('names preserve Korean, spaces and earlier dots', () => {
  assert.equal(outputName('2026.여름 여행.MP4', 2, 4), '2026.여름 여행_2of4.mp4');
  assert.equal(outputName('video', 1, 2), 'video_1of2.mp4');
});

test('invalid file sizes, durations and unreasonable counts are rejected', () => {
  for (const size of [0, -1, NaN, Infinity]) assert.throws(() => splitCount(size));
  for (const duration of [0, -1, NaN, Infinity]) assert.throws(() => makePlan('a.mp4', 100, duration));
  assert.throws(() => splitCount(100, 0));
  assert.throws(() => makePlan('a.mp4', TARGET_BYTES * 2001, 100));
});

test('time rounding carries into the next minute or hour', () => {
  assert.equal(formatTime(59.96, true), '01:00.0');
  assert.equal(formatTime(3599.96, true), '1:00:00.0');
  assert.equal(formatTime(61.24, true), '01:01.2');
  assert.equal(formatTime(NaN), '—');
  assert.equal(formatTime(-1), '—');
});

test('sizes and estimated remaining times are clearly labelled', () => {
  assert.equal(formatBytes(250_000_000), '250.0 MB');
  assert.equal(formatBytes(1_100_000_000), '1.10 GB');
  assert.equal(formatEta(Infinity), '계산 중');
  assert.equal(formatEta(3), '잠시 후');
  assert.equal(formatEta(12), '약 15초');
  assert.equal(formatEta(61), '약 2분');
});

test('untrusted filenames are escaped before HTML rendering', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">&\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
});

test('cancellation and storage errors have actionable Korean messages', () => {
  assert.match(errorMessage(new DOMException('stopped', 'AbortError')), /중지/);
  assert.match(errorMessage(new DOMException('full', 'QuotaExceededError')), /저장공간/);
});

test('strict size planning uses the previous safe GOP and preserves a hard payload ceiling', () => {
  const plan = makeSizePlan('여행.mp4', [
    { start: 0, end: 2, bytes: 40 },
    { start: 2, end: 4, bytes: 35 },
    { start: 4, end: 6, bytes: 50 },
    { start: 6, end: 8, bytes: 30 },
  ], 90, 100);
  assert.deepEqual(plan.map(part => [part.start, part.end, part.estimatedBytes]), [[0, 4, 75], [4, 8, 80]]);
  assert.deepEqual(plan.map(part => part.name), ['여행_1of2.mp4', '여행_2of2.mp4']);
});

test('one safe GOP at or above the hard cap requires explicit re-encoding consent', () => {
  assert.throws(() => makeSizePlan('a.mp4', [{ start: 0, end: 10, bytes: 100 }], 90, 100), ReencodeRequiredError);
});
