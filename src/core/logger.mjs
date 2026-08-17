import { redact } from "./redact.mjs";

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/**
 * Small structured logger that writes only to stderr so MCP stdout remains protocol-clean.
 */
export class Logger {
  /** @param {{level?: keyof typeof LEVELS, component?: string, sink?: NodeJS.WritableStream}} [options] */
  constructor(options = {}) {
    this.level = options.level ?? "info";
    this.component = options.component ?? "bridge";
    this.sink = options.sink ?? process.stderr;
  }

  /** Return a child logger with an extended component name. */
  child(component) {
    return new Logger({ level: this.level, component: `${this.component}:${component}`, sink: this.sink });
  }

  /** Emit a debug record. */
  debug(message, fields) { this.#write("debug", message, fields); }
  /** Emit an informational record. */
  info(message, fields) { this.#write("info", message, fields); }
  /** Emit a warning record. */
  warn(message, fields) { this.#write("warn", message, fields); }
  /** Emit an error record. */
  error(message, fields) { this.#write("error", message, fields); }

  #write(level, message, fields) {
    if ((LEVELS[level] ?? 100) < (LEVELS[this.level] ?? 20)) return;
    const record = {
      time: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...(fields === undefined ? {} : { fields: redact(fields) }),
    };
    this.sink.write(`${JSON.stringify(record)}\n`);
  }
}
