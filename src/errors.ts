/** Machine-readable error codes thrown by the SDK. */
export type EsewaErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_PARAMS"
  | "INVALID_RESPONSE"
  | "SIGNATURE_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "PAYMENT_NOT_COMPLETE"
  | "SERVICE_UNAVAILABLE"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "UNAUTHORIZED";

/** Every error thrown by this SDK is an `EsewaError`. */
export class EsewaError extends Error {
  readonly code: EsewaErrorCode;
  /** Extra context (HTTP status, raw body, decoded payload, ...). */
  readonly details?: unknown;

  constructor(code: EsewaErrorCode, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EsewaError";
    this.code = code;
    this.details = details;
  }
}

export function isEsewaError(err: unknown): err is EsewaError {
  return err instanceof EsewaError;
}
