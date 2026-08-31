// Generated fixtures only. This Node-only test codec adapter is never bundled into the website.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { registerMediabunnyServer } from '@mediabunny/server';
import { BlobSource, BufferTarget, EncodedPacketSink, Input, MP4, QTFF } from 'mediabunny';
import { inspectVideo } from '../src/engine.ts';
import type { OutputDestination } from '../src/engine.ts';
import { inspectJob, processVideo } from '../src/processor.ts';
import { resizeVideo } from '../src/resize.ts';
import type { ProcessingPlan, Resolution, SegmentResult } from '../src/model.ts';

registerMediabunnyServer({ hardwareContext: null });
const directory = resolve('.test-media', 'resize');
await mkdir(directory, { recursive: true });
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 32 * 1024 * 1024 });
const probe = (path: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_format', '-show_streams', '-of', 'json', path], { encoding: 'utf8' }));
const openInput = (file: Blob) => new Input({ formats: [MP4, QTFF], source: new BlobSource(file) });
const load = async (name: string) => new File([await readFile(join(directory, name))], name);

function memoryDestination() {
  const target = new BufferTarget();
  const state = { removed: false, finished: false };
  const destination: OutputDestination = {
    target,
    finish: async () => { assert.ok(target.buffer); state.finished = true; return new Blob([target.buffer]); },
    remove: async () => { state.removed = true; },
  };
  return { ...destination, state, target };
}

async function records(file: Blob) {
  const input = openInput(file);
  try {
    const tracks = [...await input.getVideoTracks(), ...await input.getAudioTracks()];
    return await Promise.all(tracks.map(async track => {
      const packets = [];
      for await (const packet of new EncodedPacketSink(track).packets()) {
        packets.push({ hash: createHash('sha256').update(packet.data).digest('hex'), timestamp: packet.timestamp, duration: packet.duration, type: packet.type });
      }
      return packets;
    }));
  } finally { input.dispose(); }
}

async function saveAndVerify(file: File, name: string) {
  const path = join(directory, name);
  await writeFile(path, new Uint8Array(await file.arrayBuffer()));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', path, '-map', '0', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { path, metadata: probe(path) };
}

async function verifyResize(name: string, resolution: Resolution) {
  const original = await load(name);
  const plan = await inspectJob(original, { mode: 'resize', resolution });
  assert.ok(plan.reencode);
  const destination = memoryDestination();
  let last = 0;
  const converted = await resizeVideo(original, plan, destination, {
    onProgress: progress => { assert.ok(progress >= last && progress <= 1); last = progress; },
  });
  assert.ok(destination.state.finished && !destination.state.removed);
  const { metadata, path } = await saveAndVerify(converted, `${name}-${resolution}p.mp4`);
  const sourceMetadata = probe(join(directory, name));
  const video = metadata.streams.find((stream: any) => stream.codec_type === 'video');
  const sourceVideo = sourceMetadata.streams.find((stream: any) => stream.codec_type === 'video');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, plan.outputWidth);
  assert.equal(video.height, plan.outputHeight);
  assert.equal(video.side_data_list?.find((side: any) => side.rotation !== undefined)?.rotation ?? 0, 0, 'rotation is baked into actual pixels');
  assert.equal(video.nb_read_frames, sourceVideo.nb_read_frames, 'no decoded video frames lost or added');
  assert.equal(metadata.streams.length, sourceMetadata.streams.length);
  const before = await records(original);
  const after = await records(converted);
  const videoTimes = (packets: typeof before[number]) => packets.map(packet => packet.timestamp).sort((a, b) => a - b);
  const sourceTimes = videoTimes(before[0]);
  const resultTimes = videoTimes(after[0]);
  assert.equal(resultTimes.length, sourceTimes.length);
  const commonShift = resultTimes[0] - sourceTimes[0];
  sourceTimes.forEach((time, index) => assert.ok(Math.abs(resultTimes[index] - time - commonShift) < 0.003, 'preserve original video timing, including VFR'));
  for (let a = 1; a < before.length; a++) {
    assert.deepEqual(after[a].map(packet => packet.hash), before[a].map(packet => packet.hash), `audio ${a}: all original compressed packets, including negative priming, copied without re-encoding`);
    before[a].forEach((packet, index) => assert.ok(Math.abs(after[a][index].timestamp - packet.timestamp - commonShift) < 0.003, 'all tracks shift together to preserve A/V sync'));
    const sourceAudio = sourceMetadata.streams.filter((stream: any) => stream.codec_type === 'audio')[a - 1];
    const resultAudio = metadata.streams.filter((stream: any) => stream.codec_type === 'audio')[a - 1];
    assert.equal(resultAudio.sample_rate, sourceAudio.sample_rate);
    assert.equal(resultAudio.channels, sourceAudio.channels);
    // The current demuxer does not interpret legacy QuickTime numeric language tags.
    // This documented metadata limitation must never affect the audio bytes or track count.
    if (!/\.mov$/i.test(name)) assert.equal(resultAudio.tags?.language, sourceAudio.tags?.language);
  }
  const outputInfo = await inspectVideo(converted);
  assert.ok(Math.abs(outputInfo.duration - plan.source.duration) < 0.1);
  // Compare decoded pixels against an independent FFmpeg scale/rotation reference. No browser or screenshots.
  const frameArgs = ['-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'];
  const expectedFrame = ffmpeg(['-i', join(directory, name), '-vf', `scale=${plan.outputWidth}:${plan.outputHeight}:force_original_aspect_ratio=decrease,pad=${plan.outputWidth}:${plan.outputHeight}:(ow-iw)/2:(oh-ih)/2`, ...frameArgs]);
  const actualFrame = ffmpeg(['-i', path, ...frameArgs]);
  assert.equal(actualFrame.length, expectedFrame.length);
  let totalError = 0;
  for (let index = 0; index < actualFrame.length; index++) totalError += Math.abs(actualFrame[index] - expectedFrame[index]);
  assert.ok(totalError / actualFrame.length < 15, 'visible orientation and aspect ratio must match the reference');
  console.log(`PASS ${name} -> ${plan.outputWidth}x${plan.outputHeight}: H.264, frame timing, visible rotation/aspect, ${plan.source.audioTracks} audio tracks and duration`);
  return { original, converted, plan };
}

ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=12:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=8', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-bf', '2', '-c:a', 'aac', '-metadata:s:a:0', 'language=kor', '-metadata:s:a:1', 'language=eng', '-shortest', join(directory, '가족 여행.MP4')]);
const landscape = await verifyResize('가족 여행.MP4', 480);
await verifyResize('가족 여행.MP4', 720);

ffmpeg(['-display_rotation', '90', '-i', join(directory, '가족 여행.MP4'), '-map', '0', '-c', 'copy', join(directory, '세로.영상.MOV')]);
assert.equal(probe(join(directory, '세로.영상.MOV')).streams[0].side_data_list?.find((side: any) => side.rotation !== undefined)?.rotation, 90, 'the portrait fixture must actually contain rotation metadata');
const portrait = await verifyResize('세로.영상.MOV', 480);
assert.equal(portrait.plan.outputWidth, 480);
assert.equal(portrait.plan.outputHeight, 852);

ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=6:duration=2', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', join(directory, '1440p.mp4')]);
await verifyResize('1440p.mp4', 1080);

ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=12:duration=6', '-vf', "select='if(lt(t,3),not(mod(n,2)),1)'", '-fps_mode', 'vfr', '-an', '-c:v', 'libx264', '-threads', '2', '-g', '12', '-bf', '2', '-preset', 'fast', join(directory, 'variable-no-audio.mp4')]);
await verifyResize('variable-no-audio.mp4', 480);

ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=12:duration=4', '-an', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0:log-level=error', '-tag:v', 'hvc1', join(directory, 'hevc.mp4')]);
await verifyResize('hevc.mp4', 480);

// Run both production passes. The count must be based on the converted output, not input or an estimate.
const intermediate = memoryDestination();
const segments: ReturnType<typeof memoryDestination>[] = [];
const plans: ProcessingPlan[] = [];
const results: SegmentResult[] = [];
const targetBytes = Math.ceil(landscape.converted.size / 2.5);
let lastFraction = 0;
await processVideo(landscape.original, { mode: 'resize-split', resolution: 480 }, {
  createResize: async () => intermediate,
  createSegment: async () => { const destination = memoryDestination(); segments.push(destination); return destination; },
  ensureSpace: async () => {},
}, {
  targetBytes,
  onPlan: plan => { plans.push(plan); },
  onProgress: progress => { assert.ok(progress.fraction >= lastFraction && progress.fraction <= 1); lastFraction = progress.fraction; },
  onSegment: result => { results.push(result); },
});
assert.ok(intermediate.state.removed, 'intermediate is removed after final segments are ready');
assert.ok(segments.every(destination => destination.state.finished && !destination.state.removed));
assert.ok(plans[0].awaitingSize);
assert.ok(!plans.at(-1)!.awaitingSize);
assert.equal(results.length, Math.ceil(plans.at(-1)!.convertedBytes! / targetBytes));
assert.notEqual(results.length, Math.ceil(landscape.original.size / targetBytes), 'fixture proves the count is not derived from the source');
const intermediateRecords = await records(new Blob([intermediate.target.buffer!]));
const joined = intermediateRecords.map(() => [] as { hash: string; timestamp: number }[]);
for (const result of results) {
  assert.equal(result.name, `가족 여행_${result.index}of${results.length}.mp4`);
  assert.ok(!result.original);
  await saveAndVerify(result.file, `split-${result.index}.mp4`);
  const segmentRecords = await records(result.file);
  const offset = result.start + intermediateRecords[0][0].timestamp - segmentRecords[0][0].timestamp;
  segmentRecords.forEach((track, t) => joined[t].push(...track.map(packet => ({ hash: packet.hash, timestamp: packet.timestamp + offset }))));
}
intermediateRecords.forEach((track, t) => {
  assert.deepEqual(joined[t].map(packet => packet.hash), track.map(packet => packet.hash), 'the split pass copies every packet exactly once, with no second video encode');
  track.forEach((packet, index) => assert.ok(Math.abs(joined[t][index].timestamp - packet.timestamp) < 0.003));
});
console.log(`PASS actual-size resize then split: ${results.length} playable named clips; all converted packets preserved without a second encode`);

const controller = new AbortController();
const canceled = memoryDestination();
await assert.rejects(resizeVideo(landscape.original, landscape.plan, canceled, {
  signal: controller.signal, onProgress: progress => { if (progress > 0 && progress < 1) controller.abort(); },
}), { name: 'AbortError' });
assert.ok(canceled.state.removed && !canceled.state.finished, 'cancellation cleans up the incomplete output');
console.log('PASS cancellation during real encoding removes the unfinished file');

const unchanged = await inspectJob(landscape.original, { mode: 'resize', resolution: 1080 });
assert.equal(unchanged.reencode, false);
assert.equal(unchanged.parts[0].name, landscape.original.name);
console.log('PASS already-small video bypasses re-encoding and preserves the original filename');

ffmpeg(['-i', join(directory, 'hevc.mp4'), '-c', 'copy', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', join(directory, 'hdr.mp4')]);
await assert.rejects(inspectJob(await load('hdr.mp4'), { mode: 'resize', resolution: 480 }), /HDR/);
assert.equal((await inspectJob(await load('hdr.mp4'), { mode: 'split', resolution: 'original' })).reencode, false);
console.log('PASS HDR resize is rejected before output creation; original split-only remains available');
