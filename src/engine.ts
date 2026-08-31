import {
  BlobSource, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  Input, MP4, QTFF, Mp4OutputFormat, Output,
} from 'mediabunny';
import type { EncodedPacket, InputAudioTrack, InputVideoTrack, Target } from 'mediabunny';
import { makePlan, TARGET_BYTES } from './model.ts';
import type { SegmentPlan, SegmentResult, SplitProgress, VideoInfo } from './model.ts';

export interface OutputDestination {
  target: Target;
  finish: () => Promise<Blob>;
  remove: () => Promise<void>;
}

type DestinationFactory = (part: SegmentPlan) => Promise<OutputDestination>;

function openInput(file: Blob): Input {
  return new Input({ formats: [MP4, QTFF], source: new BlobSource(file, { maxCacheSize: 8 * 1024 * 1024 }) });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('작업이 중지되었습니다.', 'AbortError');
}

async function tracksFor(input: Input): Promise<{ video: InputVideoTrack; audios: InputAudioTrack[] }> {
  const videos = await input.getVideoTracks();
  const audios = await input.getAudioTracks();
  if (videos.length !== 1) throw new Error('영상 트랙이 하나인 일반 MP4·MOV 파일을 선택해 주세요.');
  const video = videos[0];
  const format = new Mp4OutputFormat();
  const videoCodec = await video.getCodec();
  if (!videoCodec || !format.getSupportedVideoCodecs().includes(videoCodec) || !await video.getDecoderConfig()) {
    throw new Error('이 영상 코덱은 재압축 없이 MP4로 나눌 수 없어요. H.264 또는 HEVC 영상을 사용해 주세요.');
  }
  for (const audio of audios) {
    const codec = await audio.getCodec();
    if (!codec || !format.getSupportedAudioCodecs().includes(codec) || !await audio.getDecoderConfig()) {
      throw new Error('이 파일의 소리 형식은 MP4로 그대로 보존할 수 없어요. 소리를 지우거나 재압축하지 않고 작업을 중단합니다.');
    }
  }
  return { video, audios };
}

export async function inspectVideo(file: File, target = TARGET_BYTES): Promise<VideoInfo> {
  if (!/\.(mp4|mov|m4v)$/i.test(file.name)) throw new Error('MP4, MOV 또는 M4V 영상을 선택해 주세요.');
  const input = openInput(file);
  try {
    const { video, audios } = await tracksFor(input);
    const first = await video.getFirstTimestamp();
    const end = await input.computeDuration();
    const duration = end - Math.max(0, first);
    const parts = makePlan(file.name, file.size, duration, target);
    return {
      duration,
      width: await video.getDisplayWidth(),
      height: await video.getDisplayHeight(),
      codec: (await video.getCodec())!,
      audioTracks: audios.length,
      parts,
      needsSplit: parts.length > 1,
    };
  } catch (error) {
    if (error instanceof Error && /unsupported|unrecognized|Invalid.*(box|file)|end of file|Unknown format/i.test(error.message)) {
      throw new Error('영상을 읽을 수 없어요. 손상되지 않은 MP4·MOV 파일인지 확인해 주세요.');
    }
    throw error;
  } finally { input.dispose(); }
}

// Cut on independently decodable key packets. Encoded media bytes are never decoded or encoded.
async function videoBoundaries(sink: EncodedPacketSink, count: number, start: number, end: number, signal?: AbortSignal): Promise<EncodedPacket[]> {
  const first = await sink.getFirstPacket({ verifyKeyPackets: true });
  if (!first || first.type !== 'key') throw new Error('원본 영상의 시작 프레임을 독립적으로 재생할 수 없어 분할하지 않았어요.');
  const boundaries = [first];
  for (let i = 1; i < count; i++) {
    throwIfAborted(signal);
    const ideal = start + (end - start) * i / count;
    const before = await sink.getKeyPacket(ideal, { verifyKeyPackets: true });
    const after = before ? await sink.getNextKeyPacket(before, { verifyKeyPackets: true }) : null;
    const previous = boundaries[boundaries.length - 1];
    const valid = [before, after].filter((p): p is EncodedPacket => !!p && p.timestamp > previous.timestamp + 1e-6 && p.timestamp < end - 1e-6 && p.sequenceNumber > previous.sequenceNumber);
    valid.sort((a, b) => Math.abs(a.timestamp - ideal) - Math.abs(b.timestamp - ideal));
    let chosen = valid[0];
    if (!chosen) {
      const next = await sink.getNextKeyPacket(previous, { verifyKeyPackets: true });
      if (next && next.timestamp < end - 1e-6 && next.timestamp > previous.timestamp + 1e-6) chosen = next;
    }
    if (!chosen) throw new Error(`이 영상은 재생 기준 프레임이 부족해 ${count}개로 나눌 수 없어요. 재압축 없이 분할 가능한 구간이 부족합니다.`);
    boundaries.push(chosen);
  }
  return boundaries;
}

// The same audio boundary is shared by adjacent outputs, assigning every packet exactly once.
async function audioBoundary(sink: EncodedPacketSink, timestamp: number): Promise<EncodedPacket | null> {
  let packet = await sink.getPacket(timestamp);
  if (!packet) packet = await sink.getFirstPacket();
  while (packet && packet.timestamp < timestamp - 1e-7) packet = await sink.getNextPacket(packet);
  return packet;
}

async function verifyClosedBoundaries(sink: EncodedPacketSink, boundaries: EncodedPacket[], signal?: AbortSignal): Promise<void> {
  // Open GOPs may reference pictures in the previous clip. Never silently lose those frames.
  for (const boundary of boundaries) {
    let packet = await sink.getNextPacket(boundary, { metadataOnly: true });
    while (packet && packet.type !== 'key') {
      throwIfAborted(signal);
      if (packet.timestamp < boundary.timestamp - 1e-6) {
        throw new Error('이 영상의 분할 지점에는 이전 구간을 참조하는 프레임이 있어요(열린 GOP). 조각을 단독 재생하면 프레임이 빠질 수 있어 재압축 없는 분할을 중단했어요.');
      }
      packet = await sink.getNextPacket(packet, { metadataOnly: true });
    }
  }
}

export async function splitVideo(
  file: File,
  createDestination: DestinationFactory,
  options: {
    targetBytes?: number;
    signal?: AbortSignal;
    onProgress?: (progress: SplitProgress) => void;
    onSegment?: (result: SegmentResult) => void | Promise<void>;
  } = {},
): Promise<void> {
  const info = await inspectVideo(file, options.targetBytes ?? TARGET_BYTES);
  throwIfAborted(options.signal);
  if (!info.needsSplit) {
    await options.onSegment?.({ index: 1, name: file.name, start: 0, end: info.duration, duration: info.duration, size: file.size, file, original: true });
    return;
  }
  const input = openInput(file);
  const abortInput = () => input.dispose();
  options.signal?.addEventListener('abort', abortInput, { once: true });
  let processedBytes = 0;
  let lastTick = 0;
  try {
    const { video, audios } = await tracksFor(input);
    const videoSink = new EncodedPacketSink(video);
    const audioSinks = audios.map(track => new EncodedPacketSink(track));
    const start = Math.max(0, await video.getFirstTimestamp());
    const end = await input.computeDuration();
    const boundaries = await videoBoundaries(videoSink, info.parts.length, start, end, options.signal);
    await verifyClosedBoundaries(videoSink, boundaries, options.signal);
    const audioBoundaries = await Promise.all(audioSinks.map(async sink => {
      const cuts: (EncodedPacket | null)[] = [await sink.getFirstPacket()];
      for (let i = 1; i < boundaries.length; i++) cuts.push(await audioBoundary(sink, boundaries[i].timestamp));
      return cuts;
    }));
    const videoCodec = (await video.getCodec())!;
    const videoConfig = (await video.getDecoderConfig())!;
    const rotation = await video.getRotation();
    const audioCodecs = await Promise.all(audios.map(a => a.getCodec()));
    const audioConfigs = await Promise.all(audios.map(a => a.getDecoderConfig()));
    const audioMetadata = await Promise.all(audios.map(async a => ({ languageCode: await a.getLanguageCode(), disposition: await a.getDisposition() })));

    for (let i = 0; i < boundaries.length; i++) {
      throwIfAborted(options.signal);
      const from = i === 0 ? start : boundaries[i].timestamp;
      const to = boundaries[i + 1]?.timestamp ?? end;
      const part = { ...info.parts[i], start: from - start, end: to - start };
      const notify = (phase: SplitProgress['phase']) => options.onProgress?.({
        fraction: Math.min(0.99, processedBytes / file.size), processedBytes,
        part: i + 1, partCount: boundaries.length, phase,
      });
      notify('preparing');
      throwIfAborted(options.signal);
      const destination = await createDestination(part);
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: destination.target });
      const iterators: AsyncGenerator<EncodedPacket>[] = [];
      try {
        throwIfAborted(options.signal);
        const videoSource = new EncodedVideoPacketSource(videoCodec);
        output.addVideoTrack(videoSource, { rotation, decoderConfig: videoConfig });
        const audioSources = audioCodecs.map(codec => new EncodedAudioPacketSource(codec!));
        for (let a = 0; a < audios.length; a++) output.addAudioTrack(audioSources[a], { decoderConfig: audioConfigs[a]!, ...audioMetadata[a] });
        iterators.push(videoSink.packets(boundaries[i], boundaries[i + 1]));
        for (let a = 0; a < audios.length; a++) {
          const audioFrom = audioBoundaries[a][i];
          iterators.push(audioFrom ? audioSinks[a].packets(audioFrom, audioBoundaries[a][i + 1] ?? undefined) : (async function* () {})());
        }
        await output.start();
        const sources = [videoSource, ...audioSources];
        const heads = await Promise.all(iterators.map(iterator => iterator.next()));
        // AAC encoder priming can start slightly before zero. Shift ALL tracks together;
        // clamping each track separately would damage A/V sync. Encoded bytes stay intact.
        const timestampBase = Math.min(from, ...heads.filter(head => !head.done).map(head => head.value!.timestamp));
        heads.forEach((head, index) => { if (head.done) sources[index].close(); });
        while (true) {
          throwIfAborted(options.signal);
          // Interleave tracks while retaining each track's decode order (important for B-frames).
          let next = -1;
          for (let t = 0; t < heads.length; t++) {
            if (!heads[t].done && (next < 0 || heads[t].value!.timestamp < heads[next].value!.timestamp)) next = t;
          }
          if (next < 0) break;
          const packet = heads[next].value!;
          const clone = packet.clone({ timestamp: packet.timestamp - timestampBase });
          if (next === 0) await videoSource.add(clone, { decoderConfig: videoConfig });
          else await audioSources[next - 1].add(clone, { decoderConfig: audioConfigs[next - 1]! });
          processedBytes += packet.byteLength;
          heads[next] = await iterators[next].next();
          if (heads[next].done) sources[next].close();
          if (performance.now() - lastTick >= 100) {
            notify('copying');
            lastTick = performance.now();
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
        notify('finalizing');
        await output.finalize();
        throwIfAborted(options.signal);
        const blob = await destination.finish();
        const verification = openInput(blob);
        let duration: number;
        try {
          duration = await verification.computeDuration();
          const resultTrack = await verification.getPrimaryVideoTrack();
          const first = resultTrack ? await new EncodedPacketSink(resultTrack).getFirstPacket({ metadataOnly: true }) : null;
          if (!first || first.type !== 'key' || !Number.isFinite(duration) || duration <= 0) throw new Error('결과 영상 검증에 실패했어요. 손상된 조각은 저장하지 않습니다.');
        } finally { verification.dispose(); }
        const result = new File([blob], part.name, { type: 'video/mp4' });
        await options.onSegment?.({ index: part.index, name: part.name, start: part.start, end: part.end, duration, size: result.size, file: result });
      } catch (error) {
        try { await output.cancel(); } catch { /* It may already be finalized. */ }
        await destination.remove();
        if (options.signal?.aborted) throw new DOMException('작업이 중지되었습니다.', 'AbortError');
        throw error;
      } finally {
        await Promise.all(iterators.map(iterator => iterator.return(undefined as never).catch(() => undefined)));
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('작업이 중지되었습니다.', 'AbortError');
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortInput);
    input.dispose();
  }
}
