import { BlobSource, canEncodeVideo, Conversion, Input, MP4, QTFF, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { inspectVideo } from './engine.ts';
import type { OutputDestination } from './engine.ts';
import { resizedName } from './model.ts';
import type { ProcessingPlan } from './model.ts';

const openInput = (file: Blob) => new Input({ formats: [MP4, QTFF], source: new BlobSource(file, { maxCacheSize: 8 * 1024 * 1024 }) });
const abortError = () => new DOMException('작업을 중지했어요.', 'AbortError');

export async function checkResizeSupport(file: File, plan: ProcessingPlan): Promise<NonNullable<ProcessingPlan['encoding']>> {
  const input = openInput(file);
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !await video.canDecode()) throw new Error('이 브라우저는 원본 영상 코덱을 해상도 변경용으로 읽을 수 없어요. 다른 브라우저를 사용하거나 “분할만”을 선택해 주세요.');
    if (await video.hasHighDynamicRange()) throw new Error('HDR·넓은 색역 영상의 밝기와 색상을 보존하는 해상도 변경은 아직 지원하지 않아요. “분할만”은 원본 데이터를 유지합니다.');
    const stats = await video.computePacketStats(120);
    const fps = Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0 ? stats.averagePacketRate : 30;
    const pixelBudget = plan.outputWidth * plan.outputHeight * Math.min(120, fps) * 0.1;
    const sourceBudget = stats.averageBitrate > 0 ? stats.averageBitrate * 0.9 : pixelBudget;
    let bitrate = Math.round(Math.max(200_000, Math.min(pixelBudget, sourceBudget)));
    if (typeof WorkerGlobalScope !== 'undefined') {
      let canDraw = false;
      try { canDraw = typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(2, 2).getContext('2d'); }
      catch { /* A browser may expose the API without permitting a worker canvas. */ }
      if (!canDraw) throw new Error('이 브라우저에서는 백그라운드 영상 크기 변경을 지원하지 않아요. 다른 브라우저를 사용하거나 “분할만”을 선택해 주세요.');
    }
    const audioStats = await Promise.all((await input.getAudioTracks()).map(track => track.computePacketStats(120)));
    const audioBitrate = audioStats.reduce((sum, item) => sum + (Number.isFinite(item.averageBitrate) ? item.averageBitrate : 256_000), 0);
    if (plan.options.forceReencode && plan.strictCap) {
      // Keyframes are inserted every two seconds. Keep one encoded GOP comfortably below the
      // selected cap so the verified packet-copy pass can always choose a safe boundary.
      const gopBudgetBits = plan.maxBytes * 8 * 0.72;
      bitrate = Math.round(Math.max(200_000, Math.min(bitrate, gopBudgetBits / 2 - audioBitrate)));
    }
    if (!await canEncodeVideo('avc', { width: plan.outputWidth, height: plan.outputHeight, quality: new Quality({ bitrate }) })) {
      throw new Error('이 브라우저에서는 선택한 해상도의 H.264 영상 저장을 지원하지 않아요. 더 낮은 해상도나 다른 브라우저를 사용하거나 “분할만”을 선택해 주세요.');
    }
    return { bitrate, estimatedBytes: Math.ceil((bitrate + audioBitrate) * plan.source.duration / 8 * 1.15) };
  } finally { input.dispose(); }
}

// This is the only re-encoding path. The existing splitter never calls an encoder.
export async function resizeVideo(file: File, plan: ProcessingPlan, destination: OutputDestination, options: {
  signal?: AbortSignal;
  onProgress?: (fraction: number, finalizing: boolean) => void;
} = {}): Promise<File> {
  const input = openInput(file);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: destination.target });
  let conversion: Conversion | undefined;
  let canceling: Promise<void> | undefined;
  const cancel = () => {
    if (conversion && conversion.state !== 'canceled' && conversion.state !== 'done') canceling ??= conversion.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (options.signal?.aborted) throw abortError();
    const encoding = plan.encoding ?? await checkResizeSupport(file, plan);
    // AAC priming packets can precede zero. Start at the earliest packet, rather than the
    // Conversion default of zero, to copy every audio packet and shift all tracks together.
    const firstTimestamp = Math.min(0, await input.getFirstTimestamp());
    conversion = await Conversion.init({
      input, output, tracks: 'all',
      trim: { start: firstTimestamp },
      video: {
        width: plan.outputWidth, height: plan.outputHeight, fit: 'contain',
        codec: 'avc', quality: new Quality({ bitrate: encoding.bitrate }),
        allowRotationMetadata: false, keyFrameInterval: 2,
        // Omit frameRate to preserve the original (including variable) frame timing.
      },
      audio: { forceTranscode: false },
    });
    if (!conversion.isValid || conversion.discardedTracks.length) {
      throw new Error('영상 또는 소리 트랙을 모두 보존할 수 없어 변환을 중단했어요. 지원되는 브라우저에서 다시 시도해 주세요.');
    }
    if (options.signal?.aborted) throw abortError();
    let lastTick = -Infinity;
    conversion.onProgress = value => {
      if (performance.now() - lastTick >= 100 || value === 1) {
        options.onProgress?.(Math.max(0, Math.min(1, value)), value >= 1);
        lastTick = performance.now();
      }
    };
    await conversion.execute();
    if (options.signal?.aborted) throw abortError();
    options.onProgress?.(1, true);
    const blob = await destination.finish();
    const result = new File([blob], resizedName(file.name), { type: 'video/mp4' });
    const info = await inspectVideo(result);
    if (info.width !== plan.outputWidth || info.height !== plan.outputHeight || info.audioTracks !== plan.source.audioTracks || Math.abs(info.duration - plan.source.duration) > 0.5) {
      throw new Error('변환 결과의 해상도·소리·재생시간 검증에 실패했어요. 이 결과는 저장하지 않습니다.');
    }
    if (options.signal?.aborted) throw abortError();
    return result;
  } catch (error) {
    cancel();
    await canceling;
    if (output.state !== 'canceled' && output.state !== 'finalized') await output.cancel().catch(() => undefined);
    await destination.remove();
    if (options.signal?.aborted) throw abortError();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await canceling;
    input.dispose();
  }
}
