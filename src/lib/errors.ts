/**
 * Errors FireLab raises on purpose. `code` is stable (tools and the HTTP API
 * map it to a status), `hint` tells a person or an agent what to do next.
 */
export type ErrorCode =
  | 'adb-missing'
  | 'adb-failed'
  | 'timeout'
  | 'no-device'
  | 'device-not-found'
  | 'unauthorized'
  | 'offline'
  | 'ambiguous-device'
  | 'not-running'
  | 'no-webview'
  | 'cdp-failed'
  | 'eval-failed'
  | 'bad-request'
  | 'confirm-required'
  | 'not-found'
  | 'busy'
  | 'unsupported';

export class FireLabError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, opts: { hint?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'FireLabError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  /** "message. hint" — what we show people. */
  get friendly(): string {
    return this.hint ? `${this.message}. ${this.hint}` : this.message;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof FireLabError) return err.friendly;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** HTTP status for an error code. */
export function httpStatus(err: unknown): number {
  if (!(err instanceof FireLabError)) return 500;
  switch (err.code) {
    case 'bad-request':
    case 'confirm-required':
      return 400;
    case 'device-not-found':
    case 'not-found':
    case 'no-device':
      return 404;
    case 'busy':
      return 409;
    case 'unauthorized':
    case 'offline':
    case 'not-running':
    case 'no-webview':
    case 'ambiguous-device':
    case 'unsupported':
      return 409;
    case 'eval-failed':
      return 422;
    case 'cdp-failed':
      return 502;
    case 'timeout':
      return 504;
    case 'adb-missing':
      return 503;
    default:
      return 500;
  }
}
