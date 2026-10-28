import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { decryptChromiumCookie } from "../src/lib/cookies";

function encryptChromiumCookie(value: string, password: string, prefix = Buffer.alloc(0)): Uint8Array {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  const body = Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(value)])), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), body]);
}

describe("Chromium cookie decryption", () => {
  test("decrypts v10 cookies", () => {
    expect(decryptChromiumCookie(encryptChromiumCookie("token-123", "secret"), "secret", 23)).toBe("token-123");
  });

  test("strips the domain hash that version 24 databases prepend", () => {
    const domainHash = createHash("sha256").update(".music.apple.com").digest();
    const encrypted = encryptChromiumCookie("token-123", "secret", domainHash);
    expect(decryptChromiumCookie(encrypted, "secret", 24)).toBe("token-123");
  });
});
