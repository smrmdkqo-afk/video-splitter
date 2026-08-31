import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferTarget, EncodedAudioPacketSource, EncodedPacket, Mp4OutputFormat, Output } from 'mediabunny';
import type { Target } from 'mediabunny';
import { createDiskDestination, ensureSpace, releaseStorageLock, removeJobFiles } from '../src/storage.ts';

// Exercise production storage with a small OPFS contract double, not a browser.
let synchronous = true;
let available = 10_000_000_000;
class TestFile {
  bytes = new Uint8Array(0);
  closed = false;
  positions: number[] = [];
  createSyncAccessHandle?: () => Promise<unknown>;
  constructor() {
    if (synchronous) this.createSyncAccessHandle = async () => ({
      write: (data: Uint8Array, options: { at: number }) => this.write(data, options.at),
      truncate: (size: number) => this.truncate(size),
      flush: () => {}, close: () => { this.closed = true; },
    });
  }
  truncate(size: number): void {
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, size));
    this.bytes = next;
  }
  write(data: Uint8Array, position: number): number {
    this.positions.push(position);
    if (position + data.length > this.bytes.length) this.truncate(position + data.length);
    this.bytes.set(data, position);
    return data.length;
  }
  async createWritable() {
    return {
      write: async (chunk: { position: number; data: Uint8Array }) => { this.write(chunk.data, chunk.position); },
      truncate: async (size: number) => this.truncate(size),
      close: async () => { this.closed = true; },
      abort: async () => { this.closed = true; },
    };
  }
  async getFile(): Promise<File> {
    assert.ok(this.closed, 'flush and close before exposing a result');
    return new File([this.bytes], 'part.mp4');
  }
}
class TestDirectory {
  entries = new Map<string, TestDirectory | TestFile>();
  async getDirectoryHandle(name: string) {
    if (!this.entries.has(name)) this.entries.set(name, new TestDirectory());
    return this.entries.get(name) as TestDirectory;
  }
  async getFileHandle(name: string) {
    if (!this.entries.has(name)) this.entries.set(name, new TestFile());
    return this.entries.get(name) as TestFile;
  }
  async removeEntry(name: string) {
    if (!this.entries.delete(name)) throw new DOMException('Missing', 'NotFoundError');
  }
}

const disk = new TestDirectory();
disk.entries.set('unrelated-app-files', new TestDirectory());
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  storage: { getDirectory: async () => disk, estimate: async () => ({ usage: 0, quota: available }) },
  locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) },
} });

async function writeTestContainer(target: Target) {
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: false }) });
  const source = new EncodedAudioPacketSource('aac');
  const decoderConfig = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) };
  output.addAudioTrack(source, { decoderConfig });
  await output.start();
  // Synthetic packet payloads test byte writing and seeking, not media decoding.
  for (let i = 0; i < 24; i++) await source.add(new EncodedPacket(new Uint8Array(128 * 1024).fill(i), 'key', i / 48, 1 / 48), { decoderConfig });
  source.close();
  await output.finalize();
}

test('OPFS sync and async destinations match a reference MP4 across 2MiB chunks', async () => {
  const reference = new BufferTarget();
  await writeTestContainer(reference);
  for (const useSync of [true, false]) {
    synchronous = useSync;
    const job = useSync ? 'sync-job' : 'async-job';
    const destination = await createDiskDestination(job, 1);
    await writeTestContainer(destination.target);
    const blob = await destination.finish();
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(reference.buffer!));
    const root = disk.entries.get('video-splitter-temp-v1') as TestDirectory;
    const folder = root.entries.get(job) as TestDirectory;
    const file = folder.entries.get('part-1.mp4') as TestFile;
    assert.ok(file.positions.length > 1);
    assert.equal(file.positions[0], 0);
    assert.ok(file.positions.some(position => position >= 2 * 1024 * 1024), 'writes must respect offsets beyond the first chunk');
    await removeJobFiles(job);
    assert.equal(root.entries.has(job), false);
    assert.ok(disk.entries.has('unrelated-app-files'), 'never delete other app data');
  }
});

test('quota checks reject insufficient space before output creation', async () => {
  available = 1000;
  await assert.rejects(ensureSpace(250_000_000), { name: 'QuotaExceededError' });
  available = 10_000_000_000;
  await ensureSpace(250_000_000);
});

test('removing an incomplete destination closes it and only removes that part', async () => {
  const destination = await createDiskDestination('cancelled-job', 1);
  await destination.remove();
  const root = disk.entries.get('video-splitter-temp-v1') as TestDirectory;
  const folder = root.entries.get('cancelled-job') as TestDirectory;
  assert.equal(folder.entries.size, 0);
  assert.ok(disk.entries.has('unrelated-app-files'));
  releaseStorageLock();
});
