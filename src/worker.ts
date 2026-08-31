import { inspectVideo, splitVideo } from './engine.ts';
import { createDiskDestination, ensureSpace, removeJobFiles } from './storage.ts';
import { errorMessage } from './model.ts';

export type WorkerRequest = {
  id: string;
  action: 'inspect' | 'split' | 'remove' | 'cancel';
  file?: File;
  jobId?: string;
};

const scope = self as unknown as DedicatedWorkerGlobalScope;
const pending: WorkerRequest[] = [];
let busy = false;
let active: { id: string; controller: AbortController } | undefined;

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.action === 'cancel') {
    if (active?.id === event.data.id) active.controller.abort();
    return;
  }
  pending.push(event.data);
  void drain();
};

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    while (pending.length) {
      const request = pending.shift()!;
      active = { id: request.id, controller: new AbortController() };
      try {
        let result: unknown;
        if (request.action === 'inspect') result = await inspectVideo(request.file!);
        if (request.action === 'remove') await removeJobFiles(request.jobId!);
        if (request.action === 'split') {
          const info = await inspectVideo(request.file!);
          if (info.needsSplit) {
            await removeJobFiles(request.jobId!);
            await ensureSpace(request.file!.size);
          }
          await splitVideo(request.file!, part => createDiskDestination(request.jobId!, part.index), {
            signal: active.controller.signal,
            onProgress: progress => scope.postMessage({ id: request.id, type: 'progress', value: progress }),
            onSegment: segment => scope.postMessage({ id: request.id, type: 'segment', value: segment }),
          });
        }
        scope.postMessage({ id: request.id, type: 'result', value: result });
      } catch (error) {
        scope.postMessage({ id: request.id, type: 'error', message: errorMessage(error), name: error instanceof Error ? error.name : 'Error' });
      } finally { active = undefined; }
    }
  } finally { busy = false; }
}
