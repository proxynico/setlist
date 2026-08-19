import { describe, expect, test } from "bun:test";
import { parseSafariBinaryCookies, pickMediaUserToken } from "../src/lib/safari-cookies";

function putU32(bytes: number[], value: number, littleEndian: boolean) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, littleEndian);
  bytes.push(...buf);
}

function putCString(bytes: number[], value: string) {
  bytes.push(...new TextEncoder().encode(value), 0);
}

function encodeCookie(cookie: { domain: string; name: string; path: string; value: string }): Uint8Array {
  const domainOffset = 48;
  const nameOffset = domainOffset + cookie.domain.length + 1;
  const pathOffset = nameOffset + cookie.name.length + 1;
  const valueOffset = pathOffset + cookie.path.length + 1;
  const size = valueOffset + cookie.value.length + 1;

  const bytes: number[] = [];
  putU32(bytes, size, true);
  putU32(bytes, 0, true);
  putU32(bytes, 0, true);
  putU32(bytes, 0, true);
  putU32(bytes, domainOffset, true);
  putU32(bytes, nameOffset, true);
  putU32(bytes, pathOffset, true);
  putU32(bytes, valueOffset, true);
  bytes.push(...new Array(16).fill(0));
  putCString(bytes, cookie.domain);
  putCString(bytes, cookie.name);
  putCString(bytes, cookie.path);
  putCString(bytes, cookie.value);
  return new Uint8Array(bytes);
}

function encodeBinaryCookies(
  cookies: Array<{ domain: string; name: string; path: string; value: string }>,
): Uint8Array {
  const records = cookies.map(encodeCookie);
  const cookieOffsets: number[] = [];
  let cursor = 8 + cookies.length * 4 + 4;
  for (const record of records) {
    cookieOffsets.push(cursor);
    cursor += record.length;
  }

  const page: number[] = [0, 0, 1, 0];
  putU32(page, cookies.length, true);
  for (const offset of cookieOffsets) putU32(page, offset, true);
  putU32(page, 0, true);
  for (const record of records) page.push(...record);

  const file: number[] = [0x63, 0x6f, 0x6f, 0x6b];
  putU32(file, 1, false);
  putU32(file, page.length, false);
  file.push(...page);
  return new Uint8Array(file);
}

describe("Safari binary cookies", () => {
  test("parses cookies and prefers the Apple Music token", () => {
    const data = encodeBinaryCookies([
      {
        domain: ".tv.apple.com",
        name: "media-user-token",
        path: "/",
        value: "tv-token",
      },
      {
        domain: ".music.apple.com",
        name: "media-user-token",
        path: "/",
        value: "music-token",
      },
      {
        domain: ".example.com",
        name: "session",
        path: "/",
        value: "other",
      },
    ]);

    const cookies = parseSafariBinaryCookies(data);
    expect(cookies).toHaveLength(3);
    expect(pickMediaUserToken(cookies)).toBe("music-token");
  });

  test("falls back to any Apple media-user-token", () => {
    const data = encodeBinaryCookies([
      {
        domain: ".podcasts.apple.com",
        name: "media-user-token",
        path: "/",
        value: "podcasts-token",
      },
    ]);

    expect(pickMediaUserToken(parseSafariBinaryCookies(data))).toBe("podcasts-token");
  });

  test("rejects a buffer that is not a binarycookies file", () => {
    expect(() => parseSafariBinaryCookies(new Uint8Array([1, 2, 3, 4]))).toThrow("too small");
    expect(() => parseSafariBinaryCookies(new TextEncoder().encode("not-a-cookie-file"))).toThrow(
      "not a binarycookies store",
    );
  });
});
