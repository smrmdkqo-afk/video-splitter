import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferTarget } from 'mediabunny';
import { mediaOperations, processVideo } from '../src/processor.ts';
import type { ProcessingStorage } from '../src/processor.ts';
import { processingPlan, makePlan } from '../src/model.ts';
import type { ProcessingOptions, ProcessingPlan, SegmentResult, SplitProgress, VideoInfo } from '../src/model.ts';

function setup(options: ProcessingOptions, convertedSize = 400, sourceSize = 1000, width = 1920, height = 1080) {
  const file = new File([new Uint8Array(sourceSize)], '여름 여행.MOV');
  const converted = new File([new Uint8Array(convertedSize)], '여름 여행.mp4');
  const info: VideoInfo = { width, height, duration: 120, codec: 'avc', audioTracks: 2, needsSplit: sourceSize > 250, parts: makePlan(file.name, sourceSize, 120, 250) };
  const plan = processingPlan(file, info, options, 250);
  plan.encoding = { bitrate: 1_000_000, estimatedBytes: 500 };
  const calls = { resize: 0, split: 0, remove: 0, create: 0, spaces: [] as number[], working: undefined as File | undefined, splitRule: undefined as string | undefined };
  const destination = { target: new BufferTarget(), finish: async () => converted, remove: async () => { calls.remove++; } };
  const storage: ProcessingStorage = {
    createResize: async () => { calls.create++; return destination; },
    createSegment: async () => destination,
    ensureSpace: async bytes => { calls.spaces.push(bytes); },
  };
  const operations: typeof mediaOperations = {
    inspectJob: async () => plan,
    inspectVideo: async () => ({ ...info, width: plan.outputWidth, height: plan.outputHeight }),
    resizeVideo: async (_file, _plan, _destination, callbacks) => {
      calls.resize++;
      callbacks?.onProgress?.(0.5, false);
      callbacks?.onProgress?.(1, true);
      return converted;
    },
    splitVideo: async (working, _create, callbacks) => {
      calls.split++; calls.working = working; calls.splitRule = callbacks?.splitRule;
      const parts = makePlan(working.name, working.size, info.duration, callbacks?.targetBytes);
      for (const part of parts) {
        callbacks?.onProgress?.({ fraction: (part.index - 1) / parts.length, processedBytes: 0, part: part.index, partCount: parts.length, phase: 'copying' });
        await callbacks?.onSegment?.({ ...part, size: part.estimatedBytes, file: working, duration: part.end - part.start });
      }
    },
  };
  return { file, converted, plan, calls, storage, operations };
}

test('split-only bypasses encoding and passes the original file into the existing splitter', async () => {
  const options = { mode: 'split', resolution: 'original' } as const;
  const item = setup(options);
  const results: SegmentResult[] = [];
  await processVideo(item.file, options, item.storage, { targetBytes: 250, onSegment: result => { results.push(result); } }, item.operations);
  assert.equal(item.calls.resize, 0);
  assert.equal(item.calls.create, 0);
  assert.equal(item.calls.working, item.file);
  assert.equal(results.length, 4);
});

test('strict cap selection reaches the splitter without opting into re-encoding', async () => {
  const options = { mode: 'split', resolution: 'original', splitRule: 'size', maxBytes: 250 } as const;
  const item = setup(options);
  await processVideo(item.file, options, item.storage, {}, item.operations);
  assert.equal(item.calls.resize, 0);
  assert.equal(item.calls.splitRule, 'size');
});

test('resize-only retains its one completed intermediate for downloading and never splits', async () => {
  const options = { mode: 'resize', resolution: 720 } as const;
  const item = setup(options);
  const results: SegmentResult[] = [];
  await processVideo(item.file, options, item.storage, { targetBytes: 250, onSegment: result => { results.push(result); } }, item.operations);
  assert.equal(item.calls.resize, 1);
  assert.equal(item.calls.split, 0);
  assert.equal(item.calls.remove, 0);
  assert.equal(results[0].file, item.converted);
  assert.equal(results[0].original, false);
  assert.equal(results[0].name, '여름 여행.mp4');
  assert.equal(results[0].size, 400);
});

test('resize then split derives count and names from actual converted bytes and deletes only the intermediate', async () => {
  const options = { mode: 'resize-split', resolution: 720 } as const;
  const item = setup(options);
  const plans: ProcessingPlan[] = [];
  const results: SegmentResult[] = [];
  const progress: SplitProgress[] = [];
  await processVideo(item.file, options, item.storage, {
    targetBytes: 250, onPlan: plan => { plans.push(plan); }, onProgress: value => { progress.push(value); }, onSegment: result => { results.push(result); },
  }, item.operations);
  assert.equal(plans[0].awaitingSize, true);
  assert.equal(plans.at(-1)!.convertedBytes, 400);
  assert.equal(plans.at(-1)!.parts.length, 2);
  assert.equal(results.length, 2, '400 / 250, not the original 1000 / 250');
  assert.equal(results[0].name, '여름 여행_1of2.mp4');
  assert.equal(item.calls.working, item.converted);
  assert.equal(item.calls.resize, 1);
  assert.equal(item.calls.split, 1);
  assert.equal(item.calls.remove, 1);
  assert.deepEqual(item.calls.spaces, [500, 400]);
  progress.forEach((value, index) => {
    assert.ok(value.fraction >= 0 && value.fraction <= 1);
    if (index) assert.ok(value.fraction >= progress[index - 1].fraction);
  });
});

test('actual conversion size may increase, and split mode still uses that actual size', async () => {
  const options = { mode: 'resize-split', resolution: 480 } as const;
  const item = setup(options, 400, 200);
  const results: SegmentResult[] = [];
  await processVideo(item.file, options, item.storage, { targetBytes: 250, onSegment: value => { results.push(value); } }, item.operations);
  assert.equal(results.length, 2);
});

test('a converted file below the target is retained as one result, without _1of1', async () => {
  const options = { mode: 'resize-split', resolution: 480 } as const;
  const item = setup(options, 200);
  const results: SegmentResult[] = [];
  await processVideo(item.file, options, item.storage, { targetBytes: 250, onSegment: value => { results.push(value); } }, item.operations);
  assert.equal(item.calls.split, 0);
  assert.equal(item.calls.remove, 0);
  assert.equal(results[0].name, item.converted.name);
  assert.equal(results[0].original, false);
});

test('no-upscale resize-only returns the exact original File without any output allocation', async () => {
  const options = { mode: 'resize', resolution: 720 } as const;
  const item = setup(options, 200, 1000, 640, 360);
  let result: SegmentResult | undefined;
  await processVideo(item.file, options, item.storage, { targetBytes: 250, onSegment: value => { result = value; } }, item.operations);
  assert.equal(item.calls.resize, 0);
  assert.equal(item.calls.split, 0);
  assert.equal(item.calls.create, 0);
  assert.equal(result!.file, item.file);
  assert.equal(result!.name, item.file.name);
  assert.equal(result!.original, true);
});

test('cancellation during resizing removes its intermediate and never starts splitting', async () => {
  const options = { mode: 'resize-split', resolution: 720 } as const;
  const item = setup(options);
  const controller = new AbortController();
  await assert.rejects(processVideo(item.file, options, item.storage, {
    targetBytes: 250, signal: controller.signal,
    onProgress: progress => { if (progress.fraction > 0) controller.abort(); },
    onSegment: () => assert.fail('no incomplete file may be delivered'),
  }, item.operations), { name: 'AbortError' });
  assert.equal(item.calls.split, 0);
  assert.equal(item.calls.remove, 1);
});

test('a split error leaves completed pieces available but removes the intermediate', async () => {
  const options = { mode: 'resize-split', resolution: 720 } as const;
  const item = setup(options);
  const results: SegmentResult[] = [];
  item.operations.splitVideo = async (file, _create, callbacks) => {
    await callbacks?.onSegment?.({ index: 1, name: '여름 여행_1of2.mp4', file, start: 0, end: 60, duration: 60, size: 200 });
    throw new Error('second piece failed');
  };
  await assert.rejects(processVideo(item.file, options, item.storage, { targetBytes: 250, onSegment: result => { results.push(result); } }, item.operations), /second piece failed/);
  assert.equal(item.calls.remove, 1);
  assert.equal(results.length, 1);
});

test('capability failures and quota failures stop before creating output files', async () => {
  const options = { mode: 'resize', resolution: 720 } as const;
  const unsupported = setup(options);
  unsupported.operations.inspectJob = async () => { throw new Error('unsupported codec'); };
  await assert.rejects(processVideo(unsupported.file, options, unsupported.storage, {}, unsupported.operations), /unsupported codec/);
  assert.equal(unsupported.calls.create, 0);
  const full = setup(options);
  full.storage.ensureSpace = async () => { throw new DOMException('full', 'QuotaExceededError'); };
  await assert.rejects(processVideo(full.file, options, full.storage, {}, full.operations), { name: 'QuotaExceededError' });
  assert.equal(full.calls.create, 0);
});
