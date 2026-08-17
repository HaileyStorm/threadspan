/**
 * Async iterable queue used to bridge callback/event APIs to streaming consumers.
 * @template T
 */
export class AsyncQueue {
  constructor() {
    /** @type {T[]} */
    this.items = [];
    /** @type {Array<{resolve: (result: IteratorResult<T>) => void, reject: (error: unknown) => void}>} */
    this.waiters = [];
    this.closed = false;
    this.error = undefined;
  }

  /** @param {T} item */
  push(item) {
    if (this.closed) throw new Error("Cannot push to a closed AsyncQueue");
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  /** Close the queue after buffered items are drained. */
  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0 && this.items.length === 0) {
      this.waiters.shift().resolve({ value: undefined, done: true });
    }
  }

  /** Fail the queue and reject pending/future reads. */
  fail(error) {
    if (this.closed) return;
    this.error = error;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift().reject(error);
  }

  /** @returns {AsyncIterator<T>} */
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.error !== undefined) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
