/**
 * Error types shared by the Datadog HTTP chokepoint and everything above it.
 *
 * These are plain `Error` subclasses (not Zod-validated, not wire types) —
 * they exist so callers can `instanceof`-check failure modes without
 * string-matching messages, and so `retryable` is computed once, in one
 * place, from the HTTP status.
 */

/** Thrown when a request would leave the read-only allowlist. Never network I/O. */
export class ForbiddenRequestError extends Error {
  readonly code = 'FORBIDDEN_REQUEST';

  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenRequestError';
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, ForbiddenRequestError);
    }
  }
}

/** Statuses the caller may safely retry: 429 and any 5xx. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface DatadogApiErrorArgs {
  readonly status: number;
  readonly ddErrors?: readonly string[];
  readonly requestId?: string;
  readonly message?: string;
}

/**
 * A non-2xx response from the Datadog API. Carries only what's safe to log
 * or surface to a tool caller: status, Datadog's own `errors` array, and the
 * `x-dd-request-id` if present — never headers wholesale, never credentials.
 */
export class DatadogApiError extends Error {
  readonly status: number;
  readonly ddErrors: readonly string[];
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(args: DatadogApiErrorArgs) {
    const ddErrors = args.ddErrors ?? [];
    const message = args.message ?? DatadogApiError.defaultMessage(args.status, ddErrors);
    super(message);
    this.name = 'DatadogApiError';
    this.status = args.status;
    this.ddErrors = ddErrors;
    if (args.requestId !== undefined) {
      this.requestId = args.requestId;
    }
    this.retryable = isRetryableStatus(args.status);
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, DatadogApiError);
    }
  }

  private static defaultMessage(status: number, ddErrors: readonly string[]): string {
    const suffix = ddErrors.length > 0 ? `: ${ddErrors.join('; ')}` : '';
    return `Datadog API responded with status ${status}${suffix}`;
  }
}

/** Thrown when a Datadog response body exceeds the configured size cap. */
export class ResponseTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number, actualBytes?: number) {
    const actual = actualBytes === undefined ? 'unknown size' : `${actualBytes} bytes`;
    super(`Datadog response exceeded the ${limitBytes}-byte limit (received ${actual})`);
    this.name = 'ResponseTooLargeError';
    this.limitBytes = limitBytes;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, ResponseTooLargeError);
    }
  }
}
