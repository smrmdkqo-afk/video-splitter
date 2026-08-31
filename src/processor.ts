import { inspectVideo, splitVideo } from './engine.ts';
import type { OutputDestination } from './engine.ts';
import { checkResizeSupport, resizeVideo } from './resize.ts';
import { processingPlan, resolvedPlan, TARGET_BYTES } from './model.ts';
import type { ProcessingOptions, ProcessingPlan, SegmentPlan, SegmentResult, SplitProgress } from './model.ts';

export async function inspectJob(file: File, options: ProcessingOptions, target = TARGET_BYTES): Promise<ProcessingPlan> {
  const plan = processingPlan(file, await inspectVideo(file, target), options, target);
  if (plan.reencode) plan.encoding = await checkResizeSupport(file, plan);
  return plan;
}

export interface ProcessingStorage {
  createResize: () => Promise<OutputDestination>;
  createSegment: (part: SegmentPlan) => Promise<OutputDestination>;
  ensureSpace: (bytes: number) => Promise<void>;
}

export interface ProcessingCallbacks {
  signal?: AbortSignal;
  targetBytes?: number;
  onPlan?: (plan: ProcessingPlan) => void;
  onProgress?: (progress: SplitProgress) => void;
  onSegment?: (result: SegmentResult) => void | Promise<void>;
}

// Injectable media operations allow deterministic cancellation/queue/storage tests without a browser.
export const mediaOperations = { inspectJob, inspectVideo, resizeVideo, splitVideo };

export async function processVideo(file: File, requested: ProcessingOptions, storage: ProcessingStorage, callbacks: ProcessingCallbacks = {}, operations = mediaOperations): Promise<void> {
  const target = callbacks.targetBytes ?? TARGET_BYTES;
  const throwIfAborted = () => { if (callbacks.signal?.aborted) throw new DOMException('작업을 중지했어요.', 'AbortError'); };
  throwIfAborted();
  let plan = await operations.inspectJob(file, requested, target);
  callbacks.onPlan?.(plan);
  throwIfAborted();
  let working = file;
  let intermediate: OutputDestination | undefined;
  let keepIntermediate = false;
  const resizeShare = plan.options.mode === 'resize-split' ? 0.85 : 0.99;
  try {
    if (plan.reencode) {
      await storage.ensureSpace(plan.encoding?.estimatedBytes ?? file.size);
      throwIfAborted();
      callbacks.onProgress?.({ fraction: 0, processedBytes: 0, part: 0, partCount: 0, phase: 'resizing', stageFraction: 0 });
      intermediate = await storage.createResize();
      working = await operations.resizeVideo(file, plan, intermediate, {
        signal: callbacks.signal,
        onProgress: (fraction, finalizing) => callbacks.onProgress?.({
          fraction: fraction * resizeShare, stageFraction: fraction,
          processedBytes: Math.round(fraction * file.size), part: 0, partCount: 0,
          phase: finalizing ? 'resize-finalizing' : 'resizing',
        }),
      });
      throwIfAborted();
      callbacks.onProgress?.({ fraction: resizeShare, stageFraction: 1, processedBytes: file.size, part: 0, partCount: 0, phase: 'planning' });
      plan = resolvedPlan(plan, working, await operations.inspectVideo(working, target), target);
      callbacks.onPlan?.(plan);
    }
    throwIfAborted();
    if (plan.options.mode === 'resize' || plan.parts.length === 1) {
      const duration = plan.parts[0].end;
      await callbacks.onSegment?.({ index: 1, name: working.name, file: working, size: working.size, start: 0, end: duration, duration, original: working === file });
      keepIntermediate = !!intermediate;
      return;
    }
    // Resize-then-split is two passes: count pieces using the completed, actual resized file size.
    // The second pass copies encoded packets and never re-encodes video a second time.
    await storage.ensureSpace(working.size);
    throwIfAborted();
    await operations.splitVideo(working, storage.createSegment, {
      targetBytes: target, signal: callbacks.signal,
      onSegment: result => callbacks.onSegment?.({ ...result, original: result.original && working === file }),
      onProgress: progress => callbacks.onProgress?.({
        ...progress, stageFraction: progress.fraction,
        fraction: plan.reencode ? resizeShare + progress.fraction * (1 - resizeShare) : progress.fraction,
      }),
    });
  } finally {
    if (intermediate && !keepIntermediate) await intermediate.remove();
  }
}
