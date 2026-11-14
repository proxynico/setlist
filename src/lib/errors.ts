interface MusicErrorOptions {
  code: string;
  hint?: string;
  cause?: unknown;
}

export class MusicError extends Error {
  code: string;
  hint?: string;

  constructor(message: string, options: MusicErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "MusicError";
    this.code = options.code;
    this.hint = options.hint;
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
