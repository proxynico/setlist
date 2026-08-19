export interface MusicErrorOptions {
  code: string;
  hint?: string;
  cause?: unknown;
}

export class MusicError extends Error {
  code: string;
  hint?: string;
  cause?: unknown;

  constructor(message: string, options: MusicErrorOptions) {
    super(message);
    this.name = "MusicError";
    this.code = options.code;
    this.hint = options.hint;
    this.cause = options.cause;
  }
}

export class ValidationError extends MusicError {
  constructor(message: string, hint?: string) {
    super(message, { code: "validation_error", hint });
    this.name = "ValidationError";
  }
}

export class UnsupportedOperationError extends MusicError {
  constructor(message: string, hint?: string) {
    super(message, { code: "unsupported_operation", hint });
    this.name = "UnsupportedOperationError";
  }
}

export class AuthError extends MusicError {
  constructor(message: string, hint?: string) {
    super(message, { code: "auth_error", hint });
    this.name = "AuthError";
  }
}

export class ExternalServiceError extends MusicError {
  constructor(message: string, hint?: string, cause?: unknown) {
    super(message, { code: "external_service_error", hint, cause });
    this.name = "ExternalServiceError";
  }
}

export function isMusicError(error: unknown): error is MusicError {
  return error instanceof MusicError;
}
