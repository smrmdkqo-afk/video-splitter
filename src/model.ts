export const TARGET_BYTES = 250_000_000;
export const KAKAO_REFERENCE_BYTES = 300_000_000;

export interface SegmentPlan {
  index: number;
  name: string;
  start: number;
  end: number;
  estimatedBytes: number;
}

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  codec: string;
  audioTracks: number;
  parts: SegmentPlan[];
  needsSplit: boolean;
}

export interface SegmentResult {
  index: number;
  name: string;
  start: number;
  end: number;
  duration: number;
  size: number;
  file: File;
  original?: boolean;
}

export interface SplitProgress {
  fraction: number;
  processedBytes: number;
  part: number;
  partCount: number;
  phase: 'preparing' | 'copying' | 'finalizing' | 'resizing' | 'resize-finalizing' | 'planning';
  stageFraction?: number;
}

export type ProcessingMode = 'split' | 'resize' | 'resize-split';
export type Resolution = 'original' | 1080 | 720 | 480;
export interface ProcessingOptions { mode: ProcessingMode; resolution: Resolution }
export const DEFAULT_OPTIONS: ProcessingOptions = { mode: 'split', resolution: 'original' };

export interface ProcessingPlan {
  source: VideoInfo;
  options: ProcessingOptions;
  outputWidth: number;
  outputHeight: number;
  reencode: boolean;
  awaitingSize: boolean;
  parts: SegmentPlan[];
  convertedBytes?: number;
  encoding?: { bitrate: number; estimatedBytes: number };
}

export function validateOptions(options: ProcessingOptions): ProcessingOptions {
  if (!['split', 'resize', 'resize-split'].includes(options.mode) || !['original', 1080, 720, 480].includes(options.resolution)) {
    throw new Error('처리 방식과 출력 해상도를 다시 선택해 주세요.');
  }
  return { mode: options.mode, resolution: options.mode === 'split' ? 'original' : options.resolution };
}

// Fit within an orientation-aware box. Never crop, stretch, or enlarge a smaller source.
export function resizedDimensions(width: number, height: number, resolution: Resolution): { width: number; height: number } {
  if (![width, height].every(value => Number.isFinite(value) && value >= 2)) throw new Error('영상 해상도를 확인할 수 없어요.');
  if (resolution === 'original') return { width, height };
  const longEdge = ({ 1080: 1920, 720: 1280, 480: 854 })[resolution];
  if (!longEdge) throw new Error('지원하지 않는 출력 해상도예요.');
  const scale = Math.min(1, (width >= height ? longEdge : resolution) / width, (width >= height ? resolution : longEdge) / height);
  if (scale === 1) return { width, height };
  // Even dimensions are required by common H.264 encoders. Rounding may add <=2px letterboxing.
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) };
}

export function resizedName(original: string): string {
  return `${original.replace(/\.[^.]+$/, '') || 'video'}.mp4`;
}

export function processingPlan(file: Pick<File, 'name' | 'size'>, source: VideoInfo, requested: ProcessingOptions, target = TARGET_BYTES): ProcessingPlan {
  const options = validateOptions(requested);
  const dimensions = resizedDimensions(source.width, source.height, options.resolution);
  const reencode = dimensions.width !== source.width || dimensions.height !== source.height;
  const name = reencode ? resizedName(file.name) : file.name;
  const parts = options.mode === 'resize'
    ? [{ index: 1, name, start: 0, end: source.duration, estimatedBytes: reencode ? 0 : file.size }]
    : reencode ? [] : makePlan(name, file.size, source.duration, target);
  return { source, options, outputWidth: dimensions.width, outputHeight: dimensions.height, reencode, awaitingSize: reencode, parts };
}

export function resolvedPlan(plan: ProcessingPlan, file: File, info: VideoInfo, target = TARGET_BYTES): ProcessingPlan {
  return {
    ...plan, awaitingSize: false, convertedBytes: file.size, outputWidth: info.width, outputHeight: info.height,
    parts: plan.options.mode === 'resize'
      ? [{ index: 1, name: file.name, start: 0, end: info.duration, estimatedBytes: file.size }]
      : makePlan(file.name, file.size, info.duration, target),
  };
}

export function modeLabel(mode: ProcessingMode): string {
  return ({ split: '분할만', resize: '해상도 변경만', 'resize-split': '해상도 변경 후 분할' })[mode];
}

export function splitCount(size: number, target = TARGET_BYTES): number {
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(target) || target <= 0) {
    throw new Error('영상 용량을 확인할 수 없어요. 비어 있지 않은 파일을 선택해 주세요.');
  }
  return Math.max(1, Math.ceil(size / target));
}

export function outputName(original: string, index: number, total: number): string {
  const base = original.replace(/\.[^.]+$/, '') || 'video';
  return `${base}_${index}of${total}.mp4`;
}

export function makePlan(name: string, size: number, duration: number, target = TARGET_BYTES): SegmentPlan[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('영상의 재생시간을 확인할 수 없어요.');
  const count = splitCount(size, target);
  if (count > 2000) throw new Error('조각 수가 너무 많아요. 더 작은 원본 영상을 선택해 주세요.');
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    name: count === 1 ? name : outputName(name, i + 1, count),
    start: duration * i / count,
    end: duration * (i + 1) / count,
    estimatedBytes: size / count,
  }));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatTime(seconds: number, precise = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const rounded = precise ? Math.round(seconds * 10) / 10 : Math.round(seconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = Math.floor(rounded % 60);
  const tail = precise ? `.${Math.round((rounded % 1) * 10)}` : '';
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${tail}`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '계산 중';
  if (seconds < 5) return '잠시 후';
  if (seconds < 60) return `약 ${Math.ceil(seconds / 5) * 5}초`;
  if (seconds < 3600) return `약 ${Math.ceil(seconds / 60)}분`;
  return `약 ${Math.ceil(seconds / 3600)}시간`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '작업을 중지했어요. 다시 시작하면 이 영상부터 새로 처리합니다.';
    if (error.name === 'QuotaExceededError') return '임시 저장공간이 부족해요. 필요한 결과를 저장하고 목록에서 제거한 뒤 다시 시도해 주세요.';
    return error.message || '영상을 처리하지 못했어요. 파일을 확인해 주세요.';
  }
  return '영상을 처리하지 못했어요. 파일을 확인해 주세요.';
}
