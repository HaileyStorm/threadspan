import { RequestError } from "./errors.mjs";

/**
 * Fair provider-local admission controller for active jobs, cold-start spacing, rolling starts,
 * and an approximate weighted usage budget.
 *
 * Callers reserve expected units at admission and reconcile the reservation with the terminal
 * count when the job ends. Reconciliation may create budget debt, intentionally delaying later
 * jobs until the original rolling-window record expires.
 */
export class WeightedAdmissionController {
  /**
   * @param {{
   *   maxActive?: number,
   *   minStartIntervalMs?: number,
   *   maxStartsPerWindow?: number,
   *   maxUnitsPerWindow?: number,
   *   windowMs?: number,
   *   maxQueue?: number,
   * }} [options] Admission limits.
   */
  constructor(options = {}) {
    this.maxActive = positiveInteger(options.maxActive ?? 1, "maxActive");
    this.minStartIntervalMs = nonNegativeNumber(options.minStartIntervalMs ?? 0, "minStartIntervalMs");
    this.maxStartsPerWindow = optionalPositiveNumber(options.maxStartsPerWindow, "maxStartsPerWindow");
    this.maxUnitsPerWindow = optionalPositiveNumber(options.maxUnitsPerWindow, "maxUnitsPerWindow");
    this.windowMs = positiveNumber(options.windowMs ?? 60_000, "windowMs");
    this.maxQueue = positiveInteger(options.maxQueue ?? 100, "maxQueue");
    this.active = 0;
    this.lastStartAt = 0;
    /** @type {Array<{startedAt: number, units: number}>} */
    this.starts = [];
    /** @type {Array<{
     *   resolve: (release: (actualUnits?: number) => void) => void,
     *   reject: (error: unknown) => void,
     *   signal?: AbortSignal,
     *   units: number,
     *   cancelled: boolean,
     *   abort?: () => void,
     * }>} */
    this.queue = [];
    this.timer = undefined;
    this.closed = false;
  }

  /**
   * Wait for one admission slot and return an idempotent release/reconcile function.
   *
   * @param {number} [units=1] Estimated rolling-budget units to reserve.
   * @param {AbortSignal} [signal] Cancellation signal.
   * @returns {Promise<(actualUnits?: number) => void>}
   */
  acquire(units = 1, signal) {
    if (this.closed) return Promise.reject(new RequestError("Provider admission controller is closed"));
    signal?.throwIfAborted();
    const normalizedUnits = normalizeUnits(units, "Admission units");
    if (Number.isFinite(this.maxUnitsPerWindow) && normalizedUnits > this.maxUnitsPerWindow) {
      return Promise.reject(new RequestError(
        `Admission request reserves ${normalizedUnits} units, exceeding rolling limit ${this.maxUnitsPerWindow}`,
      ));
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new RequestError(`Provider admission queue is full (${this.maxQueue})`));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        units: normalizedUnits,
        cancelled: false,
        abort: undefined,
      };
      waiter.abort = () => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        this.queue = this.queue.filter((entry) => entry !== waiter);
        reject(signal?.reason ?? new Error("Admission cancelled"));
        this.#drain();
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      this.#drain();
    });
  }

  /** Return count-only admission diagnostics. */
  stats() {
    this.#pruneStarts(Date.now());
    return {
      active: this.active,
      queued: this.queue.length,
      startsInWindow: this.starts.length,
      unitsInWindow: this.#unitsInWindow(),
      maxActive: this.maxActive,
      minStartIntervalMs: this.minStartIntervalMs,
      maxStartsPerWindow: Number.isFinite(this.maxStartsPerWindow) ? this.maxStartsPerWindow : null,
      maxUnitsPerWindow: Number.isFinite(this.maxUnitsPerWindow) ? this.maxUnitsPerWindow : null,
      windowMs: this.windowMs,
      closed: this.closed,
    };
  }

  /** Reject queued work and prevent future admissions. Active jobs retain their release handles. */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const error = new RequestError("Provider admission controller is closed");
    for (const waiter of this.queue.splice(0)) {
      waiter.cancelled = true;
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(error);
    }
  }

  /** Admit as many FIFO waiters as current timing and capacity permit. */
  #drain() {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue = this.queue.filter((waiter) => !waiter.cancelled);

    while (this.active < this.maxActive && this.queue.length > 0) {
      const now = Date.now();
      this.#pruneStarts(now);
      const next = this.queue[0];
      const delayMs = this.#nextDelayMs(now, next.units);
      if (delayMs > 0) {
        // Keep this timer referenced: queued callers are awaiting it, and allowing the process to
        // exit here would strand their promises without a terminal result.
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.#drain();
        }, Math.max(1, delayMs));
        return;
      }

      const waiter = this.queue.shift();
      if (!waiter || waiter.cancelled) continue;
      waiter.signal?.removeEventListener("abort", waiter.abort);
      const startedAt = Date.now();
      const record = { startedAt, units: waiter.units };
      this.active += 1;
      this.lastStartAt = startedAt;
      this.starts.push(record);
      let released = false;
      waiter.resolve((actualUnits) => {
        if (released) return;
        released = true;
        if (actualUnits !== undefined && actualUnits !== null) {
          record.units = normalizeActualUnits(actualUnits);
        }
        this.active = Math.max(0, this.active - 1);
        this.#drain();
      });
    }
  }

  /** Compute the next time-based delay before another start may be admitted. */
  #nextDelayMs(now, units) {
    const spacingDelay = Math.max(0, this.lastStartAt + this.minStartIntervalMs - now);
    let windowDelay = 0;

    if (Number.isFinite(this.maxStartsPerWindow) && this.starts.length >= this.maxStartsPerWindow) {
      windowDelay = Math.max(windowDelay, this.starts[0].startedAt + this.windowMs - now);
    }

    if (Number.isFinite(this.maxUnitsPerWindow) && this.#unitsInWindow() + units > this.maxUnitsPerWindow) {
      let remaining = this.#unitsInWindow();
      let availableAt = now + this.windowMs;
      for (const record of this.starts) {
        remaining -= record.units;
        availableAt = record.startedAt + this.windowMs;
        if (remaining + units <= this.maxUnitsPerWindow) break;
      }
      windowDelay = Math.max(windowDelay, Math.max(0, availableAt - now));
    }

    return Math.max(spacingDelay, windowDelay);
  }

  /** Return reserved/reconciled units still inside the rolling window. */
  #unitsInWindow() {
    return this.starts.reduce((total, record) => total + record.units, 0);
  }

  /** Remove starts that are no longer inside the rolling window. */
  #pruneStarts(now) {
    const cutoff = now - this.windowMs;
    while (this.starts.length > 0 && this.starts[0].startedAt <= cutoff) this.starts.shift();
  }
}

/**
 * Backward-compatible count/start admission facade.
 *
 * @extends WeightedAdmissionController
 */
export class StartAdmissionController extends WeightedAdmissionController {
  /**
   * Wait for admission using the original `(signal, {units})` call shape.
   *
   * @param {AbortSignal} [signal] Cancellation signal.
   * @param {{units?: number}} [options] Estimated usage units to reserve.
   * @returns {Promise<(actualUnits?: number) => void>}
   */
  acquire(signal, options = {}) {
    return super.acquire(options.units ?? 1, signal);
  }
}

/** Validate and normalize a positive finite usage unit count. */
function normalizeUnits(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new RequestError(`${label} must be a positive finite number`);
  return numeric;
}

/** Validate and normalize a non-negative finite terminal usage count. */
function normalizeActualUnits(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new RequestError("Actual admission units must be a non-negative finite number");
  }
  return numeric;
}

/** Validate a positive finite numeric option. */
function positiveNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new RequestError(`${label} must be a positive finite number`);
  return numeric;
}

/** Validate a non-negative finite numeric option. */
function nonNegativeNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new RequestError(`${label} must be a non-negative finite number`);
  return numeric;
}

/** Validate a positive integer option. */
function positiveInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) throw new RequestError(`${label} must be a positive integer`);
  return numeric;
}

/** Normalize an optional positive limit to Infinity. */
function optionalPositiveNumber(value, label) {
  if (value === undefined || value === null) return Number.POSITIVE_INFINITY;
  return positiveNumber(value, label);
}
