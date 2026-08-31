export async function runSequential<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  options: { signal?: AbortSignal; onError?: (item: T, error: unknown) => boolean | void } = {},
): Promise<void> {
  for (const item of items) {
    if (options.signal?.aborted) break;
    try {
      await run(item);
    } catch (error) {
      if (options.signal?.aborted) break;
      if (options.onError?.(item, error) === false) break;
    }
  }
}
