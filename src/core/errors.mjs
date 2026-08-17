/**
 * Base error carrying a stable machine-readable code and optional HTTP status.
 */
export class BridgeError extends Error {
  /**
   * @param {string} message Human-readable error message.
   * @param {{code?: string, status?: number, details?: unknown, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BridgeError";
    this.code = options.code ?? "bridge_error";
    this.status = options.status ?? 500;
    this.details = options.details;
  }
}

/** Error raised when configuration is missing or invalid. */
export class ConfigError extends BridgeError {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message, { code: "config_error", status: 500, details });
    this.name = "ConfigError";
  }
}

/** Error raised when a provider does not support the requested capability. */
export class CapabilityError extends BridgeError {
  /**
   * @param {string} providerId
   * @param {string} capability
   * @param {string} [reason]
   */
  constructor(providerId, capability, reason) {
    super(`Provider '${providerId}' does not support '${capability}'${reason ? `: ${reason}` : ""}`, {
      code: "unsupported_capability",
      status: 400,
      details: { providerId, capability, reason },
    });
    this.name = "CapabilityError";
  }
}

/** Error raised for upstream provider failures. */
export class ProviderError extends BridgeError {
  /**
   * @param {string} providerId
   * @param {string} message
   * @param {{status?: number, retryable?: boolean, details?: unknown, cause?: unknown}} [options]
   */
  constructor(providerId, message, options = {}) {
    super(message, {
      code: "provider_error",
      status: options.status ?? 502,
      details: { providerId, retryable: options.retryable ?? false, upstream: options.details },
      cause: options.cause,
    });
    this.name = "ProviderError";
    this.providerId = providerId;
    this.retryable = options.retryable ?? false;
  }
}

/** Error raised when a request is malformed. */
export class RequestError extends BridgeError {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message, { code: "invalid_request", status: 400, details });
    this.name = "RequestError";
  }
}

/** Normalize arbitrary thrown values into a BridgeError. */
export function asBridgeError(error) {
  if (error instanceof BridgeError) return error;
  if (error instanceof Error) {
    return new BridgeError(error.message, { cause: error });
  }
  return new BridgeError(String(error));
}
