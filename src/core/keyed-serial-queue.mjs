/**
 * Per-key serial executor that preserves ordering without blocking unrelated keys.
 *
 * Aborted queued callers reject immediately, while their placeholder remains in the chain until
 * earlier work settles. This prevents later calls from overtaking an aborted waiter and racing the
 * still-active operation it was queued behind.
 */
export class KeyedSerialQueue {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this.tails = new Map();
  }

  /**
   * Execute an operation after prior work for the same key has settled.
   * @template T
   * @param {string} key Serialization key.
   * @param {AbortSignal|undefined} signal Caller abort signal.
   * @param {() => Promise<T>|T} operation Operation to execute.
   * @returns {Promise<T>}
   */
  run(key, signal, operation) {
    const normalizedKey = String(key);
    const previous = this.tails.get(normalizedKey) ?? Promise.resolve();
    const execution = previous.catch(() => undefined).then(async () => {
      throwIfAborted(signal);
      return operation();
    });
    const tail = execution.then(() => undefined, () => undefined);
    this.tails.set(normalizedKey, tail);
    tail.finally(() => {
      if (this.tails.get(normalizedKey) === tail) this.tails.delete(normalizedKey);
    }).catch(() => undefined);
    return raceWithAbort(execution, signal);
  }

  /** Return the number of keys with queued or active work. */
  get size() {
    return this.tails.size;
  }
}

/** Reject immediately when a signal has already been aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
}

/**
 * Race an operation with caller cancellation without breaking the underlying serialization chain.
 * @template T
 * @param {Promise<T>} operation Operation promise.
 * @param {AbortSignal|undefined} signal Abort signal.
 * @returns {Promise<T>}
 */
function raceWithAbort(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Operation aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}
