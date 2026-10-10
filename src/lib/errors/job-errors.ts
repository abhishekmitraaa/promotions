/**
 * Standard Application Job Error Taxonomy
 *
 * Implements a clean, transport-agnostic error hierarchy for workerless background execution:
 * - Decoupled from BullMQ UnrecoverableError
 * - Explicit distinction between transient/retryable and fatal/permanent failures
 * - Structured metadata (errorCode, retryAfterMs, failureCategory)
 */

export class JobError extends Error {
  public readonly isRetryable: boolean;
  public readonly code: string;
  public readonly retryAfterMs?: number;

  constructor(message: string, options: { isRetryable: boolean; code?: string; retryAfterMs?: number } = { isRetryable: false }) {
    super(message);
    this.name = "JobError";
    this.isRetryable = options.isRetryable;
    this.code = options.code || "JOB_ERROR";
    this.retryAfterMs = options.retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Transient error that should trigger exponential backoff retry
 */
export class RetryableError extends JobError {
  constructor(message: string, code = "RETRYABLE_ERROR", retryAfterMs?: number) {
    super(message, { isRetryable: true, code, retryAfterMs });
    this.name = "RetryableError";
  }
}

/**
 * Fatal error that should permanently fail the job with no further retries
 */
export class PermanentError extends JobError {
  constructor(message: string, code = "PERMANENT_ERROR") {
    super(message, { isRetryable: false, code });
    this.name = "PermanentError";
  }
}

/**
 * Provider is down, network timeout, or connection failed
 */
export class ProviderUnavailableError extends RetryableError {
  constructor(message: string, providerName?: string) {
    super(
      `Provider ${providerName || "unknown"} unavailable: ${message}`,
      "PROVIDER_UNAVAILABLE"
    );
    this.name = "ProviderUnavailableError";
  }
}

/**
 * Provider rate limit encountered (HTTP 429, queue throttle)
 */
export class RateLimitedError extends RetryableError {
  constructor(message: string, retryAfterMs?: number) {
    super(
      `Rate limit exceeded: ${message}`,
      "RATE_LIMITED",
      retryAfterMs
    );
    this.name = "RateLimitedError";
  }
}

/**
 * Recipient is invalid, rejected, or permanently suppressed
 */
export class InvalidRecipientError extends PermanentError {
  constructor(recipient: string, reason: string) {
    super(
      `Invalid recipient ${recipient}: ${reason}`,
      "INVALID_RECIPIENT"
    );
    this.name = "InvalidRecipientError";
  }
}

/**
 * Helper to determine whether an arbitrary error is retryable
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof JobError) {
    return err.isRetryable;
  }
  
  if (err && typeof err === "object") {
    const errorObj = err as Record<string, unknown>;
    
    // Check for explicit unrecoverable flags (e.g. from legacy BullMQ UnrecoverableError)
    if (errorObj.name === "UnrecoverableError" || errorObj.unrecoverable === true) {
      return false;
    }
    
    // Check for network/timeout errors (transient)
    const message = String(errorObj.message || "").toLowerCase();
    const code = String(errorObj.code || "").toUpperCase();
    
    if (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      message.includes("timeout") ||
      message.includes("econnrefused") ||
      message.includes("429") ||
      message.includes("503") ||
      message.includes("502") ||
      message.includes("504") ||
      message.includes("rate limit")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Classifies an error into a structured classification
 */
export function classifyJobError(err: unknown): {
  isRetryable: boolean;
  code: string;
  message: string;
  retryAfterMs?: number;
} {
  const message = err instanceof Error ? err.message : String(err || "Unknown error");

  if (err instanceof JobError) {
    return {
      isRetryable: err.isRetryable,
      code: err.code,
      message,
      retryAfterMs: err.retryAfterMs,
    };
  }

  const retryable = isRetryableError(err);
  return {
    isRetryable: retryable,
    code: retryable ? "TRANSIENT_FAILURE" : "PERMANENT_FAILURE",
    message,
  };
}
