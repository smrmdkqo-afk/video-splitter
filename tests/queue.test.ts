import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSequential } from '../src/queue.ts';

test('processes each selected video in order with concurrency exactly one', async () => {
  let active = 0;
  let maxActive = 0;
  const events: string[] = [];
  await runSequential([1, 2, 3], async item => {
    active++;
    maxActive = Math.max(active, maxActive);
    events.push(`start${item}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    events.push(`end${item}`);
    active--;
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
});

test('a corrupt file does not prevent later files from being processed', async () => {
  const completed: number[] = [];
  const failed: number[] = [];
  await runSequential([1, 2, 3], async item => {
    if (item === 2) throw new Error('invalid video');
    completed.push(item);
  }, { onError: item => { failed.push(item); } });
  assert.deepEqual(completed, [1, 3]);
  assert.deepEqual(failed, [2]);
});

test('a fatal storage failure can stop the remaining queue', async () => {
  const attempted: number[] = [];
  await runSequential([1, 2, 3], async item => {
    attempted.push(item);
    throw new DOMException('full', 'QuotaExceededError');
  }, { onError: () => false });
  assert.deepEqual(attempted, [1]);
});

test('cancellation leaves the next videos untouched', async () => {
  const controller = new AbortController();
  const attempted: number[] = [];
  await runSequential([1, 2, 3], async item => {
    attempted.push(item);
    controller.abort();
  }, { signal: controller.signal });
  assert.deepEqual(attempted, [1]);
});

test('an already cancelled queue never starts a video', async () => {
  const controller = new AbortController();
  controller.abort();
  await runSequential([1], async () => { assert.fail('must not run'); }, { signal: controller.signal });
});

test('a decision retry appended while processing runs last and still keeps concurrency one', async () => {
  const items = [1, 2];
  const events: number[] = [];
  await runSequential(items, async item => {
    events.push(item);
    if (item === 1) items.push(10);
  });
  assert.deepEqual(events, [1, 2, 10]);
});
