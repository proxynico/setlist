import { Database } from "bun:sqlite";
import { $ } from "bun";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalServiceError } from "./errors";
import { parseSafariBinaryCookies, pickMediaUserToken } from "./safari-cookies";

/**
 * Read Apple Music's media-user-token cookie from a browser's cookie store.
 * The cookie is set when you sign in at music.apple.com and authenticates
 * requests to amp-api.music.apple.com.
 */

export const BROWSERS = ["safari", "chrome", "firefox", "edge", "brave"] as const;
export type Browser = (typeof BROWSERS)[number];

const COOKIE = "media-user-token";
const HOME = homedir();

export function readMediaUserToken(browser: Browser): Promise<string> {
  switch (browser) {
    case "safari":
      return readSafariToken();
    case "firefox":
      return readFirefoxToken();
    case "chrome":
    case "edge":
    case "brave":
      return readChromiumToken(browser);
  }
}

function importError(browser: string, problems: string[], advice: string[]): ExternalServiceError {
  return new ExternalServiceError(
    `Could not extract media-user-token from ${browser}.`,
    [
      ...problems.map((problem) => `  - ${problem}`),
      "",
      ...advice,
      "",
      "Or paste the token manually:",
      "  setlist auth token <paste-token-here>",
    ].join("\n"),
  );
}

/** Query a cookie database through a temporary copy, since the browser may hold a lock on it. */
function queryCookieDb<T>(path: string, query: (db: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "setlist-cookies-"));
  try {
    const copy = join(dir, "cookies.db");
    copyFileSync(path, copy);
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    const db = new Database(copy);
    try {
      return query(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Safari ──

const SAFARI_COOKIE_FILES = [
  "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
  "Library/Cookies/Cookies.binarycookies",
];

async function readSafariToken(): Promise<string> {
  const problems: string[] = [];
  for (const file of SAFARI_COOKIE_FILES) {
    const path = join(HOME, file);
    if (!existsSync(path)) {
      problems.push(`~/${file}: file not found`);
      continue;
    }
    try {
      const token = pickMediaUserToken(parseSafariBinaryCookies(await readFile(path)));
      if (token) return token;
      problems.push(`~/${file}: no media-user-token cookie found`);
    } catch (err) {
      problems.push(`~/${file}: ${(err as Error).message}`);
    }
  }

  throw importError("Safari", problems, [
    "Make sure you're logged into music.apple.com in Safari.",
    "You may need to grant Full Disk Access to Terminal in System Settings > Privacy.",
    "Or copy media-user-token from Safari Web Inspector > Storage > Cookies.",
  ]);
}

// ── Firefox ──

async function readFirefoxToken(): Promise<string> {
  const profiles = join(HOME, "Library/Application Support/Firefox/Profiles");
  const databases = existsSync(profiles) ? [...new Bun.Glob("*/cookies.sqlite").scanSync(profiles)] : [];
  const problems = databases.length === 0 ? ["No Firefox cookie databases found"] : [];

  for (const database of databases) {
    const path = join(profiles, database);
    try {
      const row = queryCookieDb(path, (db) =>
        db
          .query<{ value: string }, [string]>(
            "SELECT value FROM moz_cookies WHERE name = ? AND host LIKE '%apple.com%' ORDER BY host LIKE '%music.apple.com' DESC LIMIT 1",
          )
          .get(COOKIE),
      );
      if (row?.value) return row.value;
      problems.push(`${path}: no media-user-token cookie found`);
    } catch (err) {
      problems.push(`${path}: ${(err as Error).message}`);
    }
  }

  throw importError("Firefox", problems, ["Make sure you're logged into music.apple.com in Firefox."]);
}

// ── Chromium (Chrome, Edge, Brave) ──

const CHROMIUM = {
  chrome: { name: "Chrome", dir: "Google/Chrome", keychainService: "Chrome Safe Storage" },
  edge: { name: "Edge", dir: "Microsoft Edge", keychainService: "Microsoft Edge Safe Storage" },
  brave: { name: "Brave", dir: "BraveSoftware/Brave-Browser", keychainService: "Brave Safe Storage" },
};

/** Decrypt a macOS Chromium cookie: "v10" + AES-128-CBC with a key derived from the browser's Keychain password. */
export function decryptChromiumCookie(encrypted: Uint8Array, password: string, databaseVersion: number): string {
  const data = Buffer.from(encrypted);
  if (data.subarray(0, 3).toString() !== "v10") return data.toString("utf-8");

  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  const plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
  // From database version 24, values start with a 32-byte SHA-256 of the cookie's domain.
  return (databaseVersion >= 24 ? plain.subarray(32) : plain).toString("utf-8");
}

async function readChromiumToken(browser: keyof typeof CHROMIUM): Promise<string> {
  const { name, dir, keychainService } = CHROMIUM[browser];
  const path = join(HOME, "Library/Application Support", dir, "Default/Cookies");
  const advice = [`Make sure you're logged into music.apple.com in ${name}.`];
  if (!existsSync(path)) throw importError(name, [`${path}: file not found`], advice);

  const { version, cookie } = queryCookieDb(path, (db) => ({
    version: Number(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'version'").get()?.value ?? 0),
    cookie: db
      .query<{ value: string; encrypted_value: Uint8Array }, [string]>(
        "SELECT value, encrypted_value FROM cookies WHERE name = ? AND host_key LIKE '%apple.com%' ORDER BY host_key LIKE '%music.apple.com' DESC LIMIT 1",
      )
      .get(COOKIE),
  }));
  if (!cookie) throw importError(name, [`${path}: no media-user-token cookie found`], advice);
  if (cookie.value) return cookie.value;

  const password = await $`security find-generic-password -s ${keychainService} -w`.quiet().nothrow();
  if (password.exitCode !== 0) {
    throw importError(
      name,
      [`Keychain item "${keychainService}" could not be read`],
      [...advice, `Allow Keychain access to "${keychainService}" when macOS asks.`],
    );
  }
  try {
    return decryptChromiumCookie(cookie.encrypted_value, password.stdout.toString().trim(), version);
  } catch (err) {
    throw importError(name, [`Cookie decryption failed: ${(err as Error).message}`], advice);
  }
}
