import { describe, expect, test } from "bun:test";
import {
  AuthError,
  ValidationError,
  ExternalServiceError,
  UnsupportedOperationError,
  isMusicError,
} from "../src/lib/errors";

describe("error hierarchy", () => {
  test("all error types are MusicError instances", () => {
    expect(isMusicError(new ValidationError("bad input"))).toBe(true);
    expect(isMusicError(new AuthError("no token"))).toBe(true);
    expect(isMusicError(new ExternalServiceError("JXA failed"))).toBe(true);
    expect(isMusicError(new UnsupportedOperationError("not supported"))).toBe(true);
  });

  test("plain errors are not MusicError", () => {
    expect(isMusicError(new Error("plain"))).toBe(false);
    expect(isMusicError("string")).toBe(false);
    expect(isMusicError(null)).toBe(false);
  });

  test("error codes are correct", () => {
    expect(new ValidationError("x").code).toBe("validation_error");
    expect(new AuthError("x").code).toBe("auth_error");
    expect(new ExternalServiceError("x").code).toBe("external_service_error");
    expect(new UnsupportedOperationError("x").code).toBe("unsupported_operation");
  });

  test("hints are preserved", () => {
    const err = new AuthError("Token expired", "Run setlist auth import");
    expect(err.hint).toBe("Run setlist auth import");
    expect(err.message).toBe("Token expired");
  });

  test("ExternalServiceError preserves cause", () => {
    const cause = new Error("network failure");
    const err = new ExternalServiceError("API unreachable", undefined, cause);
    expect(err.cause).toBe(cause);
  });
});
