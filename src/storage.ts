import { StreamTarget } from 'mediabunny';
import type { StreamTargetChunk } from 'mediabunny';
import type { OutputDestination } from './engine.ts';

// Only this app-owned folder is ever removed. Original user-selected files are read-only.
const DIRECTORY = 'video-splitter-temp-v1';
let rootPromise: Promise<FileSystemDirectoryHandle> | undefined;
let keepLockAlive: (() => void) | undefined;

interface SyncHandle {
  write(data: ArrayBufferView, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncHandle> };

function privateRoot(): Promise<FileSystemDirectoryHandle> {
  if (rootPromise) return rootPromise;
  rootPromise = new Promise((resolve, reject) => {
    if (!navigator.storage?.getDirectory || !navigator.locks) {
      reject(new Error('이 브라우저에서는 대용량 임시 저장을 사용할 수 없어요. 최신 Chrome 또는 Safari에서 HTTPS 주소로 열어 주세요.'));
      return;
    }
    // Prevent one tab from removing results still in use by another tab.
    void navigator.locks.request(DIRECTORY, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('다른 창에서 Video Splitter가 열려 있어요. 그 창에서 결과를 저장하고 닫은 뒤 다시 시도해 주세요.');
      const storage = await navigator.storage.getDirectory();
      try { await storage.removeEntry(DIRECTORY, { recursive: true }); }
      catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
      const root = await storage.getDirectoryHandle(DIRECTORY, { create: true });
      resolve(root);
      await new Promise<void>(release => { keepLockAlive = release; });
    }).catch(reject);
  });
  rootPromise.catch(() => { rootPromise = undefined; });
  return rootPromise;
}

export async function ensureSpace(bytes: number): Promise<void> {
  await privateRoot();
  const { usage, quota } = await navigator.storage.estimate();
  if (typeof quota === 'number' && typeof usage === 'number' && quota - usage < bytes * 1.03 + 16 * 1024 * 1024) {
    throw new DOMException('Not enough temporary storage.', 'QuotaExceededError');
  }
}

export async function createDiskDestination(jobId: string, part: number): Promise<OutputDestination> {
  const root = await privateRoot();
  const directory = await root.getDirectoryHandle(jobId, { create: true });
  const internalName = `part-${part}.mp4`;
  const handle = await directory.getFileHandle(internalName, { create: true }) as SyncFileHandle;
  let closed = false;
  let sync: SyncHandle | undefined;
  let asyncStream: FileSystemWritableFileStream | undefined;
  let size = 0;
  if (handle.createSyncAccessHandle) {
    sync = await handle.createSyncAccessHandle();
    sync.truncate(0);
  } else {
    asyncStream = await handle.createWritable();
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (sync) {
      try { sync.truncate(size); sync.flush(); } finally { sync.close(); }
    } else {
      try { await asyncStream!.truncate(size); await asyncStream!.close(); }
      catch (error) { await asyncStream!.abort().catch(() => undefined); throw error; }
    }
  }
  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      if (sync) {
        const written = sync.write(chunk.data, { at: chunk.position });
        if (written !== chunk.data.byteLength) throw new Error('임시 파일 쓰기를 완료하지 못했어요. 저장 공간을 확인해 주세요.');
      } else {
        await asyncStream!.write({ type: 'write', position: chunk.position, data: chunk.data as Uint8Array<ArrayBuffer> });
      }
      size = Math.max(size, chunk.position + chunk.data.byteLength);
    },
    close,
    abort: close,
  });
  return {
    target: new StreamTarget(writable, { chunked: true, chunkSize: 2 * 1024 * 1024 }),
    finish: async () => { await close(); return handle.getFile(); },
    remove: async () => {
      try { await close(); } finally { await directory.removeEntry(internalName).catch(() => undefined); }
    },
  };
}

export async function removeJobFiles(jobId: string): Promise<void> {
  if (!rootPromise) return;
  const root = await rootPromise;
  try { await root.removeEntry(jobId, { recursive: true }); }
  catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
}

export function releaseStorageLock(): void { keepLockAlive?.(); }
