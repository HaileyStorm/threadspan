import { createId } from "./ids.mjs";

/**
 * In-memory response/thread store with bounded TTL eviction.
 * The store intentionally keeps normalized messages, not raw HTTP headers or credentials.
 */
export class SessionStore {
  /** @param {{ttlMs?: number, maxEntries?: number, now?: () => number}} [options] */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
    /** @type {Map<string, any>} */
    this.responses = new Map();
    /** @type {Map<string, any>} */
    this.threads = new Map();
  }

  /** Create or fetch a durable bridge thread record. */
  getOrCreateThread(threadId, initial = {}) {
    this.sweep();
    const id = threadId || createId("thread");
    let thread = this.threads.get(id);
    if (!thread) {
      thread = {
        id,
        createdAt: this.now(),
        updatedAt: this.now(),
        messages: [],
        providerState: {},
        ...initial,
      };
      this.threads.set(id, thread);
      this.#enforceLimit(this.threads);
    }
    thread.updatedAt = this.now();
    return thread;
  }

  /** Append normalized messages to a thread. */
  appendMessages(threadId, messages) {
    const thread = this.getOrCreateThread(threadId);
    thread.messages.push(...structuredClone(messages));
    thread.updatedAt = this.now();
    return thread;
  }

  /** Store a completed response and its normalized transcript linkage. */
  putResponse(response, state = {}) {
    this.sweep();
    const record = {
      response: structuredClone(response),
      createdAt: this.now(),
      updatedAt: this.now(),
      ...structuredClone(state),
    };
    this.responses.set(response.id, record);
    this.#enforceLimit(this.responses);
    return record;
  }

  /** Return a stored response record, or undefined when absent/expired. */
  getResponse(responseId) {
    this.sweep();
    const record = this.responses.get(responseId);
    if (record) record.updatedAt = this.now();
    return record;
  }

  /** Return a stored thread record, or undefined when absent/expired. */
  getThread(threadId) {
    this.sweep();
    const thread = this.threads.get(threadId);
    if (thread) thread.updatedAt = this.now();
    return thread;
  }

  /** Delete a thread and all response records explicitly linked to it. */
  deleteThread(threadId) {
    this.threads.delete(threadId);
    for (const [responseId, record] of this.responses.entries()) {
      if (record.threadId === threadId) this.responses.delete(responseId);
    }
  }

  /** Remove expired entries. */
  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, record] of this.responses.entries()) {
      if (record.updatedAt < cutoff) this.responses.delete(id);
    }
    for (const [id, record] of this.threads.entries()) {
      if (record.updatedAt < cutoff) this.threads.delete(id);
    }
  }

  /** Return count-only diagnostics without exposing content. */
  stats() {
    this.sweep();
    return { responses: this.responses.size, threads: this.threads.size, ttlMs: this.ttlMs, maxEntries: this.maxEntries };
  }

  #enforceLimit(map) {
    while (map.size > this.maxEntries) {
      let oldestKey;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, value] of map.entries()) {
        if (value.updatedAt < oldestTime) {
          oldestKey = key;
          oldestTime = value.updatedAt;
        }
      }
      if (oldestKey === undefined) return;
      map.delete(oldestKey);
    }
  }
}
