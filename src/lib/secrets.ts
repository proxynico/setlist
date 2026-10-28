import { $ } from "bun";
import { AuthError } from "./errors";

const SERVICE = "setlist";
const MEDIA_USER_TOKEN = "media-user-token";
const DEVELOPER_TOKEN = "developer-token";

async function readSecret(account: string): Promise<string | undefined> {
  const result = await $`security find-generic-password -s ${SERVICE} -a ${account} -w`.quiet().nothrow();
  if (result.exitCode !== 0) return undefined;
  return result.stdout.toString().trim() || undefined;
}

async function writeSecret(account: string, value: string): Promise<boolean> {
  const result = await $`security add-generic-password -U -s ${SERVICE} -a ${account} -w ${value}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function deleteSecret(account: string): Promise<void> {
  await $`security delete-generic-password -s ${SERVICE} -a ${account}`.quiet().nothrow();
}

// API commands read the token once per page; keep one Keychain read per process.
let mediaUserToken: Promise<string | undefined> | undefined;

export function getMediaUserToken(): Promise<string | undefined> {
  mediaUserToken ??= readSecret(MEDIA_USER_TOKEN);
  return mediaUserToken;
}

export async function setMediaUserToken(token: string): Promise<void> {
  if (!(await writeSecret(MEDIA_USER_TOKEN, token))) {
    throw new AuthError(
      "Failed to save the Apple Music token to Keychain",
      "Grant Terminal access to Keychain if prompted, or re-run `setlist auth token <token>`.",
    );
  }
  mediaUserToken = Promise.resolve(token);
}

export async function clearMediaUserToken(): Promise<void> {
  await deleteSecret(MEDIA_USER_TOKEN);
  mediaUserToken = Promise.resolve(undefined);
}

/** The public developer token scraped from the Apple Music web player, cached between runs. */
export function getCachedDeveloperToken(): Promise<string | undefined> {
  return readSecret(DEVELOPER_TOKEN);
}

export async function cacheDeveloperToken(token: string): Promise<void> {
  // Best effort: a failed write only means the next run scrapes the web player again.
  await writeSecret(DEVELOPER_TOKEN, token);
}
