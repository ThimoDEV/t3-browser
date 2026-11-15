// Run async work one at a time, in arrival order. A failing job never blocks the next one.
// Used where two threads must not interleave: screenshot tab switches (one per browser) and
// tab-group creation (one per thread).

export function createQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

/** One queue per key (e.g. per thread), created on demand. */
export function createKeyedQueue(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, ReturnType<typeof createQueue>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    let q = queues.get(key);
    if (!q) queues.set(key, (q = createQueue()));
    return q(fn);
  };
}
