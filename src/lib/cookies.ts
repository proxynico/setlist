import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { $ } from "bun";
import { setMediaUserToken } from "./config";
import { ExternalServiceError, ValidationError } from "./errors";
import { parseSafariBinaryCookies, pickMediaUserToken } from "./safari-cookies";

/**
 * Extract the media-user-token cookie from a browser's cookie store.
 * This is the Apple Music equivalent of Spogo's sp_dc/sp_key cookie import.
 *
 * The media-user-token is set when you log into music.apple.com.
 * It authenticates requests to amp-api.music.apple.com.
 */

type Browser = "safari" | "chrome" | "firefox" | "edge" | "brave";

const COOKIE_EXTRACT_TIMEOUT_MS = 10_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new ExternalServiceError(`${label} timed out after ${ms / 1000}s`)), ms),
  );
  return Promise.race([promise, timeout]);
}

export async function importCookiesFromBrowser(browser: Browser): Promise<string> {
  switch (browser) {
    case "safari":
      return importSafariCookie();
    case "chrome":
    case "edge":
    case "brave":
      return importChromiumCookie(browser);
    case "firefox":
      return importFirefoxCookie();
    default:
      throw new ValidationError(`Unsupported browser: ${browser}`);
  }
}

/** Read and pick media-user-token from a Safari binarycookies file. */
async function readSafariBinaryToken(path: string): Promise<string | undefined> {
  const data = await readFile(path);
  return pickMediaUserToken(parseSafariBinaryCookies(data));
}

/** Pull media-user-token from Safari's binary cookie store, then legacy SQLite. */
async function importSafariCookie(): Promise<string> {
  const home = process.env.HOME || "";
  const errors: string[] = [];
  const binaryPaths = [
    "~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
    "~/Library/Cookies/Cookies.binarycookies",
  ];

  for (const dbPath of binaryPaths) {
    const expanded = dbPath.replace("~", home);
    if (!existsSync(expanded)) {
      errors.push(`${dbPath}: file not found`);
      continue;
    }
    try {
      const token = await readSafariBinaryToken(expanded);
      if (token) {
        await setMediaUserToken(token);
        return token;
      }
      errors.push(`${dbPath}: no media-user-token cookie found`);
    } catch (err) {
      errors.push(`${dbPath}: ${(err as Error).message}`);
    }
  }

  const cookieDbPaths = [
    "~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.db",
    "~/Library/Cookies/Cookies.db",
  ];

  for (const dbPath of cookieDbPaths) {
    const expanded = dbPath.replace("~", home);
    if (!existsSync(expanded)) {
      errors.push(`${dbPath}: file not found`);
      continue;
    }
    const result = await withTimeout(
      $`sqlite3 ${expanded} "SELECT value FROM cookies WHERE name='media-user-token' AND domain LIKE '%apple.com%' LIMIT 1;"`
        .quiet()
        .nothrow(),
      COOKIE_EXTRACT_TIMEOUT_MS,
      "Safari cookie extraction",
    );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      if (stderr.includes("no such table")) {
        errors.push(`${dbPath}: not a Safari cookie database`);
        continue;
      }
      errors.push(`${dbPath}: ${stderr || `exit code ${result.exitCode}`}`);
      continue;
    }
    const token = result.stdout.toString().trim();
    if (token) {
      await setMediaUserToken(token);
      return token;
    }
    errors.push(`${dbPath}: no media-user-token cookie found`);
  }

  throw new ExternalServiceError(
    "Could not extract media-user-token from Safari.",
    [
      ...errors.map((e) => `  - ${e}`),
      "",
      "Make sure you're logged into music.apple.com in Safari.",
      "You may need to grant Full Disk Access to Terminal in System Settings > Privacy.",
      "Or copy media-user-token from Safari Web Inspector > Storage > Cookies.",
      "",
      "Then paste it with:",
      "  setlist auth token <paste-token-here>",
    ].join("\n"),
  );
}

async function importChromiumCookie(browser: Browser): Promise<string> {
  // Chromium-based browsers store cookies in an encrypted SQLite database.
  // On macOS, the encryption key is in Keychain.

  const profilePaths: Record<string, string> = {
    chrome: "~/Library/Application Support/Google/Chrome/Default/Cookies",
    edge: "~/Library/Application Support/Microsoft Edge/Default/Cookies",
    brave: "~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies",
  };

  const dbPath = (profilePaths[browser] || "").replace("~", process.env.HOME || "");

  // Chromium cookies are encrypted with a key from Keychain.
  // We need to decrypt them. Use a Python script for this.
  const script = `
import sqlite3, subprocess, base64, os, sys
from hashlib import pbkdf2_hmac
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

db_path = "${dbPath}"
if not os.path.exists(db_path):
    sys.exit(1)

# Get encryption key from Keychain
browser_name = {"chrome": "Chrome", "edge": "Microsoft Edge", "brave": "Brave"}["${browser}"]
key_cmd = subprocess.run(
    ["security", "find-generic-password", "-s", f"{browser_name} Safe Storage", "-w"],
    capture_output=True, text=True
)
if key_cmd.returncode != 0:
    sys.exit(1)

key = pbkdf2_hmac("sha1", key_cmd.stdout.strip().encode(), b"saltysalt", 1003, 16)

conn = sqlite3.connect(db_path)
cursor = conn.execute(
    "SELECT encrypted_value FROM cookies WHERE name=? AND host_key LIKE ?",
    ("media-user-token", "%apple.com%")
)
row = cursor.fetchone()
conn.close()

if not row or not row[0]:
    sys.exit(1)

encrypted = row[0]
if encrypted[:3] == b"v10":
    iv = b" " * 16
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    decryptor = cipher.decryptor()
    decrypted = decryptor.update(encrypted[3:]) + decryptor.finalize()
    # Remove PKCS7 padding
    pad_len = decrypted[-1]
    print(decrypted[:-pad_len].decode("utf-8"))
else:
    print(encrypted.decode("utf-8"))
`;

  const result = await withTimeout(
    $`python3 -c ${script}`.quiet().nothrow(),
    COOKIE_EXTRACT_TIMEOUT_MS,
    `${browser} cookie decryption`,
  );
  const token = result.stdout.toString().trim();
  if (token && result.exitCode === 0) {
    await setMediaUserToken(token);
    return token;
  }

  const stderr = result.stderr.toString().trim();
  const detail =
    result.exitCode !== 0
      ? `Python exited ${result.exitCode}${stderr ? `: ${stderr}` : ""}`
      : "No token found in cookie store";

  throw new ExternalServiceError(
    `Could not extract media-user-token from ${browser}.`,
    [
      `  - ${detail}`,
      "",
      "Make sure you're logged into music.apple.com.",
      "You may need the 'cryptography' Python package: pip3 install cryptography",
      "",
      "Alternatively, paste the token manually:",
      "  setlist auth token <paste-token-here>",
    ].join("\n"),
  );
}

async function importFirefoxCookie(): Promise<string> {
  // Firefox cookies are in an unencrypted SQLite database
  const profileDir = "~/Library/Application Support/Firefox/Profiles".replace("~", process.env.HOME || "");
  const errors: string[] = [];

  const findResult = await withTimeout(
    $`find ${profileDir} -name "cookies.sqlite" -maxdepth 2`.quiet().nothrow(),
    COOKIE_EXTRACT_TIMEOUT_MS,
    "Firefox profile search",
  );
  const dbPaths = findResult.stdout.toString().trim().split("\n").filter(Boolean);

  if (dbPaths.length === 0) {
    errors.push("No Firefox cookie databases found");
  }

  for (const dbPath of dbPaths) {
    const queryResult = await withTimeout(
      $`sqlite3 ${dbPath} "SELECT value FROM moz_cookies WHERE name='media-user-token' AND baseDomain LIKE '%apple.com%' LIMIT 1;"`
        .quiet()
        .nothrow(),
      COOKIE_EXTRACT_TIMEOUT_MS,
      "Firefox cookie query",
    );
    if (queryResult.exitCode !== 0) {
      errors.push(`${dbPath}: ${queryResult.stderr.toString().trim() || `exit code ${queryResult.exitCode}`}`);
      continue;
    }
    const token = queryResult.stdout.toString().trim();
    if (token) {
      await setMediaUserToken(token);
      return token;
    }
    errors.push(`${dbPath}: no media-user-token cookie found`);
  }

  throw new ExternalServiceError(
    "Could not extract media-user-token from Firefox.",
    [
      ...errors.map((e) => `  - ${e}`),
      "",
      "Make sure you're logged into music.apple.com in Firefox.",
      "",
      "Alternatively, paste the token manually:",
      "  setlist auth token <paste-token-here>",
    ].join("\n"),
  );
}

export const SUPPORTED_BROWSERS: Browser[] = ["safari", "chrome", "firefox", "edge", "brave"];
