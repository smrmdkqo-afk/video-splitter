import type { WorkerRequest } from './worker.ts';
import type { ProcessingPlan, SegmentResult, SplitProgress } from './model.ts';

type Listener = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  progress?: (progress: SplitProgress) => void;
  segment?: (segment: SegmentResult) => void;
  plan?: (plan: ProcessingPlan) => void;
};

export class WorkerBridge {
  private worker?: Worker;
  private fatalError?: Error;
  private listeners = new Map<string, Listener>();

  private connect(): Worker {
    if (this.fatalError) throw this.fatalError;
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const listener = this.listeners.get(data.id);
      if (!listener) return;
      if (data.type === 'progress') listener.progress?.(data.value);
      if (data.type === 'segment') listener.segment?.(data.value);
      if (data.type === 'plan') listener.plan?.(data.value);
      if (data.type === 'result') { listener.resolve(data.value); this.listeners.delete(data.id); }
      if (data.type === 'error') {
        const error = new Error(data.message);
        error.name = data.name;
        listener.reject(error);
        this.listeners.delete(data.id);
      }
    };
    worker.onerror = () => {
      this.fatalError = new Error('영상 처리 작업이 종료됐어요. 완료된 결과를 먼저 저장한 뒤 페이지를 새로 열어 주세요.');
      this.fatalError.name = 'WorkerCrashedError';
      for (const listener of this.listeners.values()) listener.reject(this.fatalError);
      this.listeners.clear();
      worker.terminate();
      this.worker = undefined;
    };
    this.worker = worker;
    return worker;
  }

  request<T>(request: WorkerRequest, callbacks: Pick<Listener, 'progress' | 'segment' | 'plan'> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const worker = this.connect();
      this.listeners.set(request.id, { resolve: value => resolve(value as T), reject, ...callbacks });
      worker.postMessage(request);
    });
  }

  cancel(id: string): void { this.worker?.postMessage({ id, action: 'cancel' }); }
}
