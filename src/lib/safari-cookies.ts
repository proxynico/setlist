export interface SafariCookie {
  name: string;
  domain: string;
  value: string;
  path: string;
}

/** Read a 32-bit integer from a cookie buffer with explicit endianness. */
function readU32(data: Uint8Array, offset: number, littleEndian: boolean): number {
  if (offset + 4 > data.length) {
    throw new Error("truncated Safari cookie file");
  }
  const view = new DataView(data.buffer, data.byteOffset + offset, 4);
  return view.getUint32(0, littleEndian);
}

/** Read a NUL-terminated UTF-8 string from a cookie record. */
function readCString(data: Uint8Array, offset: number): string {
  if (offset < 0 || offset >= data.length) {
    throw new Error("invalid string offset in Safari cookie file");
  }
  let end = offset;
  while (end < data.length && data[end] !== 0) end += 1;
  return new TextDecoder().decode(data.subarray(offset, end));
}

/** Parse a Safari Cookies.binarycookies buffer into cookie records. */
export function parseSafariBinaryCookies(data: Uint8Array): SafariCookie[] {
  if (data.length < 8) {
    throw new Error("Safari cookie file is too small");
  }
  if (new TextDecoder().decode(data.subarray(0, 4)) !== "cook") {
    throw new Error("Safari cookie file is not a binarycookies store");
  }

  const pageCount = readU32(data, 4, false);
  const headerSize = 8 + pageCount * 4;
  if (headerSize > data.length) {
    throw new Error("truncated Safari cookie file header");
  }

  const pageSizes: number[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    pageSizes.push(readU32(data, 8 + i * 4, false));
  }

  const cookies: SafariCookie[] = [];
  let pageOffset = headerSize;
  for (const pageSize of pageSizes) {
    const pageEnd = pageOffset + pageSize;
    if (pageEnd > data.length) {
      throw new Error("truncated Safari cookie page");
    }
    cookies.push(...parsePage(data.subarray(pageOffset, pageEnd)));
    pageOffset = pageEnd;
  }

  return cookies;
}

/** Parse one binarycookies page into cookie records. */
function parsePage(page: Uint8Array): SafariCookie[] {
  if (page.length < 8 || page[0] !== 0 || page[1] !== 0 || page[2] !== 1 || page[3] !== 0) {
    throw new Error("invalid Safari cookie page");
  }

  const cookieCount = readU32(page, 4, true);
  const cookies: SafariCookie[] = [];
  for (let i = 0; i < cookieCount; i += 1) {
    const cookieOffset = readU32(page, 8 + i * 4, true);
    cookies.push(parseCookie(page, cookieOffset));
  }
  return cookies;
}

/** Parse one cookie record out of a page, using offsets from the record start. */
function parseCookie(page: Uint8Array, offset: number): SafariCookie {
  const size = readU32(page, offset, true);
  const cookie = page.subarray(offset, offset + size);
  if (cookie.length < 48) {
    throw new Error("truncated Safari cookie record");
  }

  const domainOffset = readU32(cookie, 16, true);
  const nameOffset = readU32(cookie, 20, true);
  const pathOffset = readU32(cookie, 24, true);
  const valueOffset = readU32(cookie, 28, true);

  return {
    domain: readCString(cookie, domainOffset),
    name: readCString(cookie, nameOffset),
    path: readCString(cookie, pathOffset),
    value: readCString(cookie, valueOffset),
  };
}

/** Prefer the Apple Music media-user-token when several Apple domains share one. */
export function pickMediaUserToken(cookies: SafariCookie[]): string | undefined {
  const matches = cookies.filter(
    (cookie) => cookie.name === "media-user-token" && cookie.domain.includes("apple.com") && cookie.value,
  );
  const music = matches.find((cookie) => cookie.domain.includes("music.apple.com"));
  return music?.value ?? matches[0]?.value;
}
