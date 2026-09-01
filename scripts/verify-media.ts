// Integration tests create their own tiny fixtures. No user videos or network are used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BlobSource, BufferTarget, EncodedPacketSink, Input, MP4, QTFF } from 'mediabunny';
import { inspectVideo, splitVideo } from '../src/engine.ts';
import type { OutputDestination } from '../src/engine.ts';
import type { SegmentResult } from '../src/model.ts';

const directory = resolve('.test-media');
await mkdir(directory, { recursive: true });
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 8 * 1024 * 1024 });
const probe = (path: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { encoding: 'utf8' }));
const openInput = (blob: Blob) => new Input({ formats: [MP4, QTFF], source: new BlobSource(blob) });

function memoryDestination(): OutputDestination {
  const target = new BufferTarget();
  return {
    target,
    finish: async () => { assert.ok(target.buffer); return new Blob([target.buffer]); },
    remove: async () => {},
  };
}

async function packetRecords(blob: Blob) {
  const input = openInput(blob);
  try {
    const tracks = [...await input.getVideoTracks(), ...await input.getAudioTracks()];
    return await Promise.all(tracks.map(async track => {
      const records = [];
      for await (const packet of new EncodedPacketSink(track).packets()) {
        records.push({ hash: createHash('sha256').update(packet.data).digest('hex'), timestamp: packet.timestamp, duration: packet.duration, type: packet.type });
      }
      return records;
    }));
  } finally { input.dispose(); }
}

async function verify(name: string, count = 4) {
  const path = join(directory, name);
  const bytes = await readFile(path);
  const file = new File([bytes], name, { type: 'video/mp4' });
  // Small test-only target lets real encoded media exercise the same production engine.
  const targetBytes = Math.ceil(file.size / (count - 0.25));
  const info = await inspectVideo(file, targetBytes);
  assert.equal(info.parts.length, count);
  const sourceRecords = await packetRecords(file);
  const joinedRecords = sourceRecords.map(() => [] as { hash: string; timestamp: number }[]);
  const sourceProbe = probe(path);
  const results: SegmentResult[] = [];
  let lastFraction = 0;
  await splitVideo(file, async () => memoryDestination(), {
    targetBytes,
    onProgress: progress => {
      assert.ok(progress.fraction >= lastFraction && progress.fraction <= 1);
      assert.equal(progress.partCount, count);
      lastFraction = progress.fraction;
    },
    onSegment: result => { results.push(result); },
  });
  assert.equal(results.length, count);
  let firstSourceTime = sourceRecords[0][0].timestamp;
  if (firstSourceTime < 0) firstSourceTime = 0;
  for (const result of results) {
    assert.equal(result.name, name.replace(/\.[^.]+$/, '') + `_${result.index}of${count}.mp4`);
    const outputPath = join(directory, result.name);
    await writeFile(outputPath, new Uint8Array(await result.file.arrayBuffer()));
    const metadata = probe(outputPath);
    assert.equal(metadata.streams.length, sourceProbe.streams.length, 'preserve every audio track');
    metadata.streams.forEach((stream: any, index: number) => {
      const source = sourceProbe.streams[index];
      assert.equal(stream.codec_name, source.codec_name);
      if (stream.codec_type === 'video') {
        assert.equal(stream.width, source.width);
        assert.equal(stream.height, source.height);
        assert.equal(stream.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ?? 0, source.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ?? 0);
      } else {
        assert.equal(stream.sample_rate, source.sample_rate);
        assert.equal(stream.channels, source.channels);
      }
    });
    // An independent decoder must accept every output, not just its MP4 metadata.
    const decoded = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', outputPath, '-map', '0', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(decoded, '');
    const records = await packetRecords(result.file);
    assert.equal(records[0][0].type, 'key');
    assert.ok(Number(metadata.format.duration) > 0);
    const commonShift = records[0][0].timestamp;
    records.forEach((track, t) => joinedRecords[t].push(...track.map(packet => ({ hash: packet.hash, timestamp: packet.timestamp - commonShift + result.start + firstSourceTime }))));
  }
  sourceRecords.forEach((track, t) => {
    assert.deepEqual(joinedRecords[t].map(p => p.hash), track.map(p => p.hash), `track ${t}: every encoded packet preserved, in order, exactly once`);
    track.forEach((packet, p) => assert.ok(Math.abs(joinedRecords[t][p].timestamp - packet.timestamp) < 0.003, `track ${t}, packet ${p}: A/V timing must stay aligned`));
  });
  assert.equal(results[0].start, 0);
  assert.ok(Math.abs(results.at(-1)!.end - info.duration) < 0.003);
  for (let i = 1; i < results.length; i++) assert.equal(results[i - 1].end, results[i].start);
  console.log(`PASS ${name}: ${count} independently decodable clips; all encoded video/audio packets and timestamps preserved`);
  return { file, targetBytes };
}

// H.264 with B-frames, AAC priming/negative timestamps and two separate audio tracks.
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=24', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=24', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'fast', '-threads', '2', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-bf', '3', '-c:a', 'aac', '-metadata:s:a:0', 'language=kor', '-metadata:s:a:1', 'language=eng', '-shortest', join(directory, '가족 여행.mp4')]);
const original = await verify('가족 여행.mp4');

// Strict mode chooses the previous safe keyframe, then verifies the real muxed size.
const strictTarget = Math.floor(original.file.size * 0.32);
const strictResults: SegmentResult[] = [];
let strictPlanCount = 0;
await splitVideo(original.file, async () => memoryDestination(), {
  targetBytes: strictTarget,
  splitRule: 'size',
  onPlan: parts => { strictPlanCount = parts.length; },
  onSegment: result => { strictResults.push(result); },
});
assert.ok(strictResults.length > 1);
assert.equal(strictResults.length, strictPlanCount);
assert.ok(strictResults.every(result => result.verifiedCap && result.size <= strictTarget), 'no downloadable result may exceed the selected hard cap');
for (const result of strictResults) {
  const outputPath = join(directory, `strict-${result.index}.mp4`);
  await writeFile(outputPath, new Uint8Array(await result.file.arrayBuffer()));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', outputPath, '-map', '0', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
}
assert.equal(strictResults[0].start, 0);
assert.ok(Math.abs(strictResults.at(-1)!.end - (await inspectVideo(original.file)).duration) < 0.003);
for (let index = 1; index < strictResults.length; index++) assert.equal(strictResults[index - 1].end, strictResults[index].start);
console.log(`PASS strict cap: ${strictResults.length} independently playable clips, every real file <= ${strictTarget} bytes`);

await assert.rejects(splitVideo(original.file, async () => { assert.fail('an oversized single GOP must be detected before output creation'); }, {
  targetBytes: Math.floor(original.file.size / 100), splitRule: 'size',
}), { name: 'ReencodeRequiredError' });
console.log('PASS strict cap impossible without re-encoding: explicit decision state and no partial outputs');

// MOV container and phone-style rotation metadata, with the same original encoded bytes.
ffmpeg(['-display_rotation', '90', '-i', join(directory, '가족 여행.mp4'), '-map', '0', '-c', 'copy', join(directory, '세로.영상.MOV')]);
assert.equal(probe(join(directory, '세로.영상.MOV')).streams[0].side_data_list?.find((side: any) => side.rotation !== undefined)?.rotation, 90, 'the portrait fixture must actually contain rotation metadata');
await verify('세로.영상.MOV', 3);

// Variable frame rate and no audio should not be converted to constant frame rate.
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=18', '-vf', "select='if(lt(t,9),not(mod(n,2)),1)'", '-fps_mode', 'vfr', '-an', '-c:v', 'libx264', '-threads', '2', '-g', '24', '-bf', '2', '-preset', 'fast', join(directory, 'variable-no-audio.mp4')]);
await verify('variable-no-audio.mp4', 3);

// Closed-GOP HEVC can be copied into independently decodable files.
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=16', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=16', '-c:v', 'libx265', '-preset', 'fast', '-x265-params', 'pools=1:frame-threads=1:keyint=48:min-keyint=48:scenecut=0:open-gop=0:log-level=error', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', join(directory, 'hevc.mp4')]);
await verify('hevc.mp4', 4);

// Reject unsafe open-GOP boundaries before creating any results.
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=12', '-an', '-c:v', 'libx265', '-preset', 'fast', '-x265-params', 'pools=1:frame-threads=1:keyint=48:min-keyint=48:scenecut=0:open-gop=1:log-level=error', '-tag:v', 'hvc1', join(directory, 'open-gop.mp4')]);
const openGop = new File([await readFile(join(directory, 'open-gop.mp4'))], 'open-gop.mp4');
await assert.rejects(splitVideo(openGop, async () => { assert.fail('must reject before creating results'); }, { targetBytes: Math.ceil(openGop.size / 3.75) }), /GOP/);
console.log('PASS unsafe open-GOP cuts are rejected before any files are created');

// Smaller videos must not be rewritten or renamed.
let untouched: SegmentResult | undefined;
await splitVideo(original.file, async () => { assert.fail('small files must bypass output creation'); }, { onSegment: result => { untouched = result; } });
assert.equal(untouched!.file, original.file);
assert.equal(untouched!.name, original.file.name);
assert.equal(untouched!.original, true);
console.log('PASS below-target file keeps its original File and filename');

await assert.rejects(splitVideo(original.file, async () => { assert.fail('must reject before creating output files'); }, { targetBytes: original.file.size / 100 }), /기준 프레임이 부족/);
console.log('PASS insufficient keyframes: clear error without changing the piece count');

// Cancellation during copying removes only the incomplete destination.
const controller = new AbortController();
let removed = 0;
let completed = 0;
await assert.rejects(splitVideo(original.file, async () => {
  const destination = memoryDestination();
  destination.remove = async () => { removed++; };
  return destination;
}, {
  targetBytes: original.targetBytes, signal: controller.signal,
  onProgress: progress => { if (progress.phase === 'copying') controller.abort(); },
  onSegment: () => { completed++; },
}), error => error instanceof Error && error.name === 'AbortError');
assert.equal(removed, 1);
assert.equal(completed, 0);
console.log('PASS cancellation cleans the incomplete clip and emits no corrupt results');

// Unreadable/unsupported input is reported rather than silently transcoded.
await assert.rejects(inspectVideo(new File(['not a video'], 'broken.mp4')));
await assert.rejects(inspectVideo(new File(['not supported'], 'movie.avi')), /MP4/);
console.log('PASS invalid/unsupported input is rejected');
console.log('All media integration checks passed.');
