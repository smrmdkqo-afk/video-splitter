import {
  BlobSource, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  Input, MP4, QTFF, Mp4OutputFormat, Output,
} from 'mediabunny';
import type { EncodedPacket, InputAudioTrack, InputVideoTrack, Target } from 'mediabunny';
import { makePlan, outputName, ReencodeRequiredError, resizedName, TARGET_BYTES } from './model.ts';
import type { SegmentPlan, SegmentResult, SplitProgress, SplitRule, VideoInfo } from './model.ts';

export interface OutputDestination {
  target: Target;
  finish: () => Promise<Blob>;
  remove: () => Promise<void>;
}

type DestinationFactory = (part: SegmentPlan) => Promise<OutputDestination>;

export interface GopEstimate {
  start: number;
  end: number;
  bytes: number;
}

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
    const valid = [before, after].filter((packet): packet is EncodedPacket => !!packet
      && packet.timestamp > previous.timestamp + 1e-6
      && packet.timestamp < end - 1e-6
      && packet.sequenceNumber > previous.sequenceNumber);
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

// Each item is one independently decodable GOP, including audio assigned to that interval.
export function makeSizePlan(name: string, gops: readonly GopEstimate[], payloadBudget: number, hardCap: number): SegmentPlan[] {
  if (!gops.length || !Number.isFinite(payloadBudget) || payloadBudget <= 0 || !Number.isFinite(hardCap) || hardCap <= 0) {
    throw new ReencodeRequiredError('안전한 분할 구간을 계산하지 못했어요. 재인코딩을 허용하면 다시 시도할 수 있어요.');
  }
  const groups: { start: number; end: number; bytes: number }[] = [];
  for (let cursor = 0; cursor < gops.length;) {
    const first = gops[cursor];
    if (first.bytes >= hardCap) throw new ReencodeRequiredError();
    let bytes = 0;
    let end = cursor;
    while (end < gops.length) {
      const next = bytes + gops[end].bytes;
      if (end > cursor && next > payloadBudget) break;
      // A single GOP may use the reserve; its real MP4 is checked after writing.
      if (end === cursor && next > payloadBudget) { bytes = next; end++; break; }
      bytes = next;
      end++;
    }
    groups.push({ start: first.start, end: gops[end - 1].end, bytes });
    cursor = end;
  }
  if (groups.length > 2000) throw new Error('조각 수가 너무 많아요. 용량 상한을 높이거나 더 작은 원본 영상을 선택해 주세요.');
  return groups.map((group, index) => ({
    index: index + 1,
    name: groups.length === 1 ? resizedName(name) : outputName(name, index + 1, groups.length),
    start: group.start,
    end: group.end,
    estimatedBytes: group.bytes,
  }));
}

async function audioBoundary(sink: EncodedPacketSink, timestamp: number): Promise<EncodedPacket | null> {
  let packet = await sink.getPacket(timestamp);
  if (!packet) packet = await sink.getFirstPacket();
  while (packet && packet.timestamp < timestamp - 1e-7) packet = await sink.getNextPacket(packet);
  return packet;
}

async function verifyClosedBoundaries(sink: EncodedPacketSink, boundaries: EncodedPacket[], signal?: AbortSignal): Promise<void> {
  for (const boundary of boundaries) {
    let packet = await sink.getNextPacket(boundary, { metadataOnly: true });
    while (packet && packet.type !== 'key') {
      throwIfAborted(signal);
      if (packet.timestamp < boundary.timestamp - 1e-6) {
        throw new ReencodeRequiredError('이 영상은 이전 구간을 참조하는 열린 GOP를 사용해 재압축 없이 안전하게 나눌 수 없어요.');
      }
      packet = await sink.getNextPacket(packet, { metadataOnly: true });
    }
  }
}

async function strictGops(
  videoSink: EncodedPacketSink,
  audioSinks: EncodedPacketSink[],
  start: number,
  end: number,
  signal?: AbortSignal,
  onScan?: (fraction: number) => void,
): Promise<{ estimates: GopEstimate[]; keys: EncodedPacket[] }> {
  const keys: EncodedPacket[] = [];
  const videoBytes: number[] = [];
  let currentBytes = 0;
  let packetCount = 0;
  for await (const packet of videoSink.packets(undefined, undefined, { verifyKeyPackets: true })) {
    throwIfAborted(signal);
    if (packet.type === 'key') {
      if (keys.length) videoBytes.push(currentBytes);
      keys.push(packet);
      currentBytes = 0;
    }
    currentBytes += packet.byteLength + (packet.sideData.alphaByteLength ?? 0);
    packetCount++;
    if (packetCount % 240 === 0) onScan?.(Math.min(0.85, packetCount / (packetCount + 240)));
  }
  if (!keys.length || keys[0].type !== 'key') throw new ReencodeRequiredError('원본 영상의 시작 프레임을 독립적으로 재생할 수 없어 재압축 없는 분할을 할 수 없어요.');
  videoBytes.push(currentBytes);

  const audioPackets = await Promise.all(audioSinks.map(async sink => {
    const packets: { timestamp: number; bytes: number }[] = [];
    for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
      throwIfAborted(signal);
      packets.push({ timestamp: packet.timestamp, bytes: packet.byteLength + (packet.sideData.alphaByteLength ?? 0) });
    }
    return packets;
  }));
  const audioPrefix = audioPackets.map(packets => {
    const prefix = [0];
    for (const packet of packets) prefix.push(prefix[prefix.length - 1] + packet.bytes);
    return prefix;
  });
  const firstAtOrAfter = (packets: { timestamp: number }[], timestamp: number): number => {
    let low = 0;
    let high = packets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (packets[middle].timestamp < timestamp - 1e-7) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const estimates = keys.map((key, index) => {
    const nextTime = keys[index + 1]?.timestamp ?? end;
    let bytes = videoBytes[index];
    for (let audio = 0; audio < audioPackets.length; audio++) {
      const from = index === 0 ? 0 : firstAtOrAfter(audioPackets[audio], key.timestamp);
      const to = index === keys.length - 1 ? audioPackets[audio].length : firstAtOrAfter(audioPackets[audio], nextTime);
      bytes += audioPrefix[audio][to] - audioPrefix[audio][from];
    }
    return { start: key.timestamp - start, end: nextTime - start, bytes };
  });
  onScan?.(1);
  return { estimates, keys };
}

function planningReserve(hardCap: number): number {
  return Math.floor(Math.min(2_000_000, Math.max(1_024, hardCap * 0.01), hardCap * 0.1));
}

function selectedBoundaries(keys: EncodedPacket[], estimates: GopEstimate[], parts: SegmentPlan[]): EncodedPacket[] {
  return parts.map(part => {
    const index = estimates.findIndex(gop => Math.abs(gop.start - part.start) < 1e-6);
    if (index < 0) throw new Error('분할 경계를 다시 계산하지 못했어요.');
    return keys[index];
  });
}

async function materializeBoundaries(sink: EncodedPacketSink, metadata: EncodedPacket[]): Promise<EncodedPacket[]> {
  return Promise.all(metadata.map(async boundary => {
    const packet = await sink.getKeyPacket(boundary.timestamp, { verifyKeyPackets: true });
    if (!packet || Math.abs(packet.timestamp - boundary.timestamp) > 1e-6) {
      throw new Error('안전한 키프레임 경계를 다시 읽지 못했어요.');
    }
    return packet;
  }));
}

export async function splitVideo(
  file: File,
  createDestination: DestinationFactory,
  options: {
    targetBytes?: number;
    splitRule?: SplitRule;
    signal?: AbortSignal;
    onPlan?: (parts: SegmentPlan[]) => void;
    onProgress?: (progress: SplitProgress) => void;
    onSegment?: (result: SegmentResult) => void | Promise<void>;
  } = {},
): Promise<void> {
  const hardCap = options.targetBytes ?? TARGET_BYTES;
  const splitRule = options.splitRule ?? 'duration';
  const info = await inspectVideo(file, hardCap);
  throwIfAborted(options.signal);
  if (!info.needsSplit) {
    await options.onSegment?.({
      index: 1, name: file.name, start: 0, end: info.duration, duration: info.duration,
      size: file.size, file, original: true, verifiedCap: splitRule === 'size',
    });
    return;
  }

  const input = openInput(file);
  const abortInput = () => input.dispose();
  options.signal?.addEventListener('abort', abortInput, { once: true });
  let lastReportedFraction = 0;
  const report = (value: SplitProgress) => {
    value.fraction = Math.max(lastReportedFraction, Math.min(1, value.fraction));
    lastReportedFraction = value.fraction;
    options.onProgress?.(value);
  };
  try {
    const { video, audios } = await tracksFor(input);
    const videoSink = new EncodedPacketSink(video);
    const audioSinks = audios.map(track => new EncodedPacketSink(track));
    const start = Math.max(0, await video.getFirstTimestamp());
    const end = await input.computeDuration();
    const videoCodec = (await video.getCodec())!;
    const videoConfig = (await video.getDecoderConfig())!;
    const rotation = await video.getRotation();
    const audioCodecs = await Promise.all(audios.map(audio => audio.getCodec()));
    const audioConfigs = await Promise.all(audios.map(audio => audio.getDecoderConfig()));
    const audioMetadata = await Promise.all(audios.map(async audio => ({ languageCode: await audio.getLanguageCode(), disposition: await audio.getDisposition() })));

    let strictAnalysis: Awaited<ReturnType<typeof strictGops>> | undefined;
    let parts = info.parts;
    let boundaries: EncodedPacket[];
    let payloadBudget = hardCap - planningReserve(hardCap);
    if (splitRule === 'size') {
      report({ fraction: 0.01, processedBytes: 0, part: 0, partCount: 0, phase: 'analyzing-keyframes', stageFraction: 0 });
      strictAnalysis = await strictGops(videoSink, audioSinks, start, end, options.signal, fraction => report({
        fraction: 0.01 + fraction * 0.07, processedBytes: 0, part: 0, partCount: 0, phase: 'analyzing-keyframes', stageFraction: fraction,
      }));
      parts = makeSizePlan(file.name, strictAnalysis.estimates, payloadBudget, hardCap);
      boundaries = await materializeBoundaries(videoSink, selectedBoundaries(strictAnalysis.keys, strictAnalysis.estimates, parts));
      await verifyClosedBoundaries(videoSink, boundaries, options.signal);
      options.onPlan?.(parts);
      report({ fraction: 0.09, processedBytes: 0, part: 0, partCount: parts.length, phase: 'planning', stageFraction: 1 });
    } else {
      boundaries = await videoBoundaries(videoSink, parts.length, start, end, options.signal);
      await verifyClosedBoundaries(videoSink, boundaries, options.signal);
      parts = parts.map((part, index) => ({ ...part, start: boundaries[index].timestamp - start, end: (boundaries[index + 1]?.timestamp ?? end) - start }));
      options.onPlan?.(parts);
    }

    const writeAttempt = async (attemptParts: SegmentPlan[], attemptBoundaries: EncodedPacket[], strict: boolean) => {
      const audioBoundaries = await Promise.all(audioSinks.map(async sink => {
        const cuts: (EncodedPacket | null)[] = [await sink.getFirstPacket()];
        for (let i = 1; i < attemptBoundaries.length; i++) cuts.push(await audioBoundary(sink, attemptBoundaries[i].timestamp));
        return cuts;
      }));
      const completed: { result: SegmentResult; destination: OutputDestination }[] = [];
      let processedBytes = 0;
      let lastTick = 0;
      try {
        for (let i = 0; i < attemptBoundaries.length; i++) {
          throwIfAborted(options.signal);
          const from = i === 0 ? start : attemptBoundaries[i].timestamp;
          const to = attemptBoundaries[i + 1]?.timestamp ?? end;
          const part = { ...attemptParts[i], start: from - start, end: to - start };
          const notify = (phase: SplitProgress['phase'], stageFraction?: number) => {
            const local = Math.min(0.99, processedBytes / Math.max(1, file.size));
            report({
              fraction: strict ? 0.1 + local * 0.88 : local,
              processedBytes, part: i + 1, partCount: attemptBoundaries.length, phase, stageFraction,
            });
          };
          notify('preparing');
          const destination = await createDestination(part);
          const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: destination.target });
          const iterators: AsyncGenerator<EncodedPacket>[] = [];
          try {
            const videoSource = new EncodedVideoPacketSource(videoCodec);
            output.addVideoTrack(videoSource, { rotation, decoderConfig: videoConfig });
            const audioSources = audioCodecs.map(codec => new EncodedAudioPacketSource(codec!));
            for (let audio = 0; audio < audios.length; audio++) output.addAudioTrack(audioSources[audio], { decoderConfig: audioConfigs[audio]!, ...audioMetadata[audio] });
            iterators.push(videoSink.packets(attemptBoundaries[i], attemptBoundaries[i + 1]));
            for (let audio = 0; audio < audios.length; audio++) {
              const audioFrom = audioBoundaries[audio][i];
              iterators.push(audioFrom ? audioSinks[audio].packets(audioFrom, audioBoundaries[audio][i + 1] ?? undefined) : (async function* () {})());
            }
            await output.start();
            const sources = [videoSource, ...audioSources];
            const heads = await Promise.all(iterators.map(iterator => iterator.next()));
            const timestampBase = Math.min(from, ...heads.filter(head => !head.done).map(head => head.value!.timestamp));
            heads.forEach((head, index) => { if (head.done) sources[index].close(); });
            while (true) {
              throwIfAborted(options.signal);
              let next = -1;
              for (let track = 0; track < heads.length; track++) {
                if (!heads[track].done && (next < 0 || heads[track].value!.timestamp < heads[next].value!.timestamp)) next = track;
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
            if (strict && blob.size > hardCap) {
              const error = new Error(`생성된 조각이 상한을 ${blob.size - hardCap}바이트 초과했어요.`);
              error.name = 'CapExceededError';
              throw error;
            }
            notify('verifying', (i + 1) / attemptBoundaries.length);
            const verification = openInput(blob);
            let duration: number;
            try {
              duration = await verification.computeDuration();
              const resultTrack = await verification.getPrimaryVideoTrack();
              const first = resultTrack ? await new EncodedPacketSink(resultTrack).getFirstPacket({ metadataOnly: true }) : null;
              if (!first || first.type !== 'key' || !Number.isFinite(duration) || duration <= 0) throw new Error('결과 영상 검증에 실패했어요. 손상된 조각은 저장하지 않습니다.');
            } finally { verification.dispose(); }
            const resultFile = new File([blob], part.name, { type: 'video/mp4' });
            completed.push({
              destination,
              result: { index: part.index, name: part.name, start: part.start, end: part.end, duration, size: resultFile.size, file: resultFile, verifiedCap: strict },
            });
            if (!strict) await options.onSegment?.(completed.at(-1)!.result);
          } catch (error) {
            try { await output.cancel(); } catch { /* It may already be finalized. */ }
            await destination.remove();
            if (options.signal?.aborted) throw new DOMException('작업이 중지되었습니다.', 'AbortError');
            throw error;
          } finally {
            await Promise.all(iterators.map(iterator => iterator.return(undefined as never).catch(() => undefined)));
          }
        }
        return completed;
      } catch (error) {
        if (strict) await Promise.all(completed.map(item => item.destination.remove().catch(() => undefined)));
        throw error;
      }
    };

    if (splitRule === 'duration') {
      await writeAttempt(parts, boundaries, false);
      report({ fraction: 1, processedBytes: file.size, part: parts.length, partCount: parts.length, phase: 'verifying', stageFraction: 1 });
      return;
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const completed = await writeAttempt(parts, boundaries, true);
        for (const item of completed) await options.onSegment?.(item.result);
        report({ fraction: 1, processedBytes: file.size, part: parts.length, partCount: parts.length, phase: 'verifying', stageFraction: 1 });
        return;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'CapExceededError') throw error;
        const previousSignature = parts.map(part => `${part.start}:${part.end}`).join('|');
        let nextSignature = previousSignature;
        for (let tightening = 0; tightening < 24 && nextSignature === previousSignature; tightening++) {
          payloadBudget = Math.max(1, Math.floor(payloadBudget * 0.94));
          parts = makeSizePlan(file.name, strictAnalysis!.estimates, payloadBudget, hardCap);
          nextSignature = parts.map(part => `${part.start}:${part.end}`).join('|');
        }
        if (nextSignature === previousSignature) throw new ReencodeRequiredError('키프레임 한 구간만으로도 MP4 용량 상한을 넘어요. 재인코딩을 허용하면 더 촘촘한 안전 구간으로 다시 만들 수 있어요.');
        boundaries = await materializeBoundaries(videoSink, selectedBoundaries(strictAnalysis!.keys, strictAnalysis!.estimates, parts));
        await verifyClosedBoundaries(videoSink, boundaries, options.signal);
        options.onPlan?.(parts);
      }
    }
    throw new ReencodeRequiredError('실제 파일 용량을 여러 번 검증했지만 상한 안으로 안전하게 나누지 못했어요.');
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('작업이 중지되었습니다.', 'AbortError');
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortInput);
    input.dispose();
  }
}
