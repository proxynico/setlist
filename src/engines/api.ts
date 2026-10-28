import type {
  MusicEngine,
  Track,
  Album,
  Artist,
  Playlist,
  PlaylistDetails,
  SearchResults,
  SearchType,
  CliConfig,
} from "../lib/types";
import { loadConfig } from "../lib/config";
import { buildIdentity, resolveRawId } from "../lib/entities";
import { mapConcurrent } from "../lib/concurrency";
import { AuthError, ExternalServiceError, isMusicError, MusicError, UnsupportedOperationError } from "../lib/errors";
import { summarizePlaylistTracks } from "../lib/library-audit";
import { cacheDeveloperToken, getCachedDeveloperToken, getMediaUserToken } from "../lib/secrets";

/**
 * Apple Music web API engine.
 * Uses the media-user-token from browser cookies to authenticate against
 * Apple's internal amp-api.music.apple.com endpoints, with the public
 * developer token the Apple Music web player ships in its JavaScript.
 */

const AMP_API_BASE = "https://amp-api.music.apple.com/v1";
const WEB_PLAYER_URL = "https://music.apple.com/";
const FETCH_TIMEOUT_MS = 15_000;
const LIBRARY_PAGE_SIZE = 100; // Apple rejects larger library pages
const PAGE_CONCURRENCY = 4;
const MAX_PAGES = 1000;

// ── Developer token ──

const WEB_PLAYER_TOKEN_ISSUER = "AMPWebPlay";
const JWT_PATTERN = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

interface JwtClaims {
  iss?: string;
  exp?: number;
}

function decodeJwtClaims(token: string): JwtClaims | undefined {
  const [header, payload] = token.split(".");
  try {
    const headerFields = recordOrEmpty(JSON.parse(Buffer.from(header, "base64url").toString()));
    const claims = recordOrEmpty(JSON.parse(Buffer.from(payload, "base64url").toString()));
    if (typeof headerFields.alg !== "string") return undefined;
    return {
      iss: typeof claims.iss === "string" ? claims.iss : undefined,
      exp: typeof claims.exp === "number" ? claims.exp : undefined,
    };
  } catch {
    return undefined;
  }
}

function isUnexpired(claims: JwtClaims, now: number): boolean {
  return claims.exp === undefined || claims.exp * 1000 > now + TOKEN_EXPIRY_MARGIN_MS;
}

/** Find an unexpired developer token in web-player HTML or JavaScript, preferring the web player's own. */
export function findDeveloperToken(text: string, now = Date.now()): string | undefined {
  let fallback: string | undefined;
  for (const [token] of text.matchAll(JWT_PATTERN)) {
    const claims = decodeJwtClaims(token);
    if (!claims || !isUnexpired(claims, now)) continue;
    if (claims.iss === WEB_PLAYER_TOKEN_ISSUER) return token;
    fallback ??= token;
  }
  return fallback;
}

async function fetchWithTimeout(url: string, label: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new ExternalServiceError(`${label} failed.`, "Check your network connection and try again.", err);
  }
}

async function scrapeDeveloperToken(): Promise<string> {
  const res = await fetchWithTimeout(WEB_PLAYER_URL, "Apple Music web player request");
  if (!res.ok) {
    throw new ExternalServiceError(`Apple Music web player error: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const inline = findDeveloperToken(html);
  if (inline) return inline;

  // The token lives in the player's JavaScript bundles; check them in page order.
  const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => new URL(m[1], WEB_PLAYER_URL).href);
  for (const url of scripts.slice(0, 10)) {
    const script = await fetchWithTimeout(url, "Apple Music JavaScript bundle request").catch(() => undefined);
    if (!script?.ok) continue;
    const token = findDeveloperToken(await script.text());
    if (token) return token;
  }

  throw new ExternalServiceError(
    "Could not extract the Apple Music developer token from the web player.",
    "Apple may have changed the web player. Use `--engine native` if you only need Music.app control.",
  );
}

interface DeveloperToken {
  value: string;
  fromCache: boolean;
}

async function scrapeAndCacheDeveloperToken(): Promise<DeveloperToken> {
  const value = await scrapeDeveloperToken();
  await cacheDeveloperToken(value);
  return { value, fromCache: false };
}

async function loadDeveloperToken(): Promise<DeveloperToken> {
  const cached = await getCachedDeveloperToken();
  const claims = cached ? decodeJwtClaims(cached) : undefined;
  if (cached && claims && isUnexpired(claims, Date.now())) return { value: cached, fromCache: true };
  return scrapeAndCacheDeveloperToken();
}

// Scraping the web player downloads several megabytes, so the token is cached
// in Keychain between runs and shared by every request in this one.
let developerTokenRequest: Promise<DeveloperToken> | undefined;

function getDeveloperToken(): Promise<DeveloperToken> {
  developerTokenRequest ??= loadDeveloperToken();
  return developerTokenRequest;
}

function refreshDeveloperToken(rejected: Promise<DeveloperToken>): Promise<DeveloperToken> {
  // Concurrent requests rejected with the same token share one refresh.
  if (developerTokenRequest === rejected) developerTokenRequest = scrapeAndCacheDeveloperToken();
  return getDeveloperToken();
}

// ── HTTP ──

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = recordOrEmpty(await res.json());
    const first = recordOrEmpty(Array.isArray(body.errors) ? body.errors[0] : undefined);
    return str(first.detail) || str(first.title);
  } catch {
    return "";
  }
}

async function apiRequest<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const mediaUserToken = await getMediaUserToken();
  if (!mediaUserToken) {
    throw new AuthError(
      "No Apple Music media-user-token is configured.",
      "Run `setlist auth import --browser safari` or `setlist auth token <token>`.",
    );
  }

  const url = new URL(`${AMP_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const send = (developerToken: string) =>
    fetchWithTimeout(url.href, "Apple Music API request", {
      headers: {
        Authorization: `Bearer ${developerToken}`,
        "Media-User-Token": mediaUserToken,
        Origin: "https://music.apple.com",
        Referer: "https://music.apple.com/",
        Accept: "application/json",
      },
    });

  const tokenRequest = getDeveloperToken();
  const developerToken = await tokenRequest;
  let res = await send(developerToken.value);
  if ((res.status === 401 || res.status === 403) && developerToken.fromCache) {
    // Apple rotates the web player token; retry once with a freshly scraped one.
    res = await send((await refreshDeveloperToken(tokenRequest)).value);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(
        "Apple Music authentication failed. The media-user-token may be expired.",
        "Re-import it with `setlist auth import --browser safari`.",
      );
    }
    const detail = await errorDetail(res);
    const message = `Apple Music API error: ${res.status} ${res.statusText}${detail ? ` (${detail})` : ""}`;
    if (res.status === 404) throw new MusicError(message, { code: "not_found" });
    throw new ExternalServiceError(message);
  }

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new ExternalServiceError("Apple Music API returned invalid JSON.", undefined, err);
  }
}

// ── Response types for Apple Music API ──

interface AMResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

interface AMResponse {
  results?: {
    songs?: { data?: AMResource[] };
    albums?: { data?: AMResource[] };
    artists?: { data?: AMResource[] };
    playlists?: { data?: AMResource[] };
  };
  data?: AMResource[];
  next?: string;
  meta?: { total?: number };
}

type ApiRequest = <T>(path: string, params?: Record<string, string>) => Promise<T>;
type ConfigLoader = () => Promise<CliConfig>;

interface ApiEngineDeps {
  request?: ApiRequest;
  configLoader?: ConfigLoader;
}

interface ApiPage {
  path: string;
  params: Record<string, string>;
}

// ── Safe field extraction from untyped API responses ──

function str(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : fallback;
}

function num(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

function firstString(val: unknown): string | undefined {
  return Array.isArray(val) ? val.find((v): v is string => typeof v === "string") : undefined;
}

function recordOrEmpty(val: unknown): Record<string, unknown> {
  return val && typeof val === "object" && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}

const CATALOG_TYPES = new Set(["songs", "albums", "artists", "playlists"]);

function extractIds(r: AMResource): { catalogId?: string; libraryId?: string } {
  const playParams = recordOrEmpty(recordOrEmpty(r.attributes).playParams);
  // For library items playParams.id is the library ID, not a catalog ID.
  const catalogId =
    str(playParams.catalogId) ||
    (playParams.isLibrary ? "" : str(playParams.id)) ||
    str(playParams.globalId) ||
    (CATALOG_TYPES.has(r.type) ? r.id : "");
  return { catalogId: catalogId || undefined, libraryId: r.type.startsWith("library-") ? r.id : undefined };
}

function resolveApiLibraryId(id: string, label: "Playlist"): string {
  return resolveRawId(id, {
    source: "api",
    kind: "library",
    label,
    description: "an Apple Music library ID",
    hint: `Use \`setlist --engine api ... --json\` and pass the ${label.toLowerCase()}'s \`libraryId\` field.`,
  });
}

function parseYear(releaseDate: unknown): number | undefined {
  if (typeof releaseDate !== "string" || releaseDate.length < 4) return undefined;
  const year = Number.parseInt(releaseDate.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : undefined;
}

function formatArtwork(artwork: unknown): string | undefined {
  const url = str(recordOrEmpty(artwork).url);
  return url ? url.replace("{w}", "300").replace("{h}", "300") : undefined;
}

function parseApiTrack(r: AMResource): Track {
  const a = recordOrEmpty(r.attributes);
  return {
    ...buildIdentity({ source: "api", ...extractIds(r) }),
    name: str(a.name, "Unknown"),
    artist: str(a.artistName, "Unknown"),
    album: str(a.albumName),
    duration: Math.round(num(a.durationInMillis) / 1000),
    trackNumber: num(a.trackNumber) || undefined,
    genre: firstString(a.genreNames),
    year: parseYear(a.releaseDate),
    artworkUrl: formatArtwork(a.artwork),
  };
}

function parseApiAlbum(r: AMResource): Album {
  const a = recordOrEmpty(r.attributes);
  return {
    ...buildIdentity({ source: "api", ...extractIds(r) }),
    name: str(a.name, "Unknown"),
    artist: str(a.artistName, "Unknown"),
    trackCount: typeof a.trackCount === "number" ? a.trackCount : undefined,
    year: parseYear(a.releaseDate),
    genre: firstString(a.genreNames),
    artworkUrl: formatArtwork(a.artwork),
  };
}

function parseApiArtist(r: AMResource): Artist {
  const a = recordOrEmpty(r.attributes);
  return {
    ...buildIdentity({ source: "api", ...extractIds(r) }),
    name: str(a.name, "Unknown"),
    genre: firstString(a.genreNames),
    artworkUrl: formatArtwork(a.artwork),
  };
}

function parseApiPlaylist(r: AMResource): Playlist {
  const a = recordOrEmpty(r.attributes);
  return {
    ...buildIdentity({ source: "api", ...extractIds(r) }),
    name: str(a.name, "Unknown"),
    description: str(recordOrEmpty(a.description).short) || undefined,
    artworkUrl: formatArtwork(a.artwork),
  };
}

function parseNextPage(next: string, limit: string): ApiPage {
  const url = new URL(next, AMP_API_BASE);
  const params = Object.fromEntries(url.searchParams.entries());
  return {
    path: url.pathname.startsWith("/v1/") ? url.pathname.slice(3) : url.pathname,
    // Apple's next links drop `limit`, which would shrink later pages to 25 items.
    params: { ...params, limit: params.limit ?? limit },
  };
}

function isNotFound(err: unknown): boolean {
  return isMusicError(err) && err.code === "not_found";
}

function tooManyPages(): ExternalServiceError {
  return new ExternalServiceError(
    `Apple Music API pagination exceeded ${MAX_PAGES} pages.`,
    "The API returned too many continuation links; try a lower limit.",
  );
}

function nativeOnly(feature: string): () => Promise<never> {
  return async () => {
    throw new UnsupportedOperationError(
      `${feature} requires the native engine.`,
      "Use `--engine native`, or `--engine auto` to combine Music.app control with API reads.",
    );
  };
}

export class ApiEngine implements MusicEngine {
  private storefront?: Promise<string>;

  constructor(private deps: ApiEngineDeps = {}) {}

  private request<T>(path: string, params?: Record<string, string>): Promise<T> {
    return (this.deps.request ?? apiRequest)<T>(path, params);
  }

  private getStorefront(): Promise<string> {
    this.storefront ??= (async () => {
      const config = await (this.deps.configLoader ?? loadConfig)();
      if (config.storefront !== "auto") return config.storefront;
      const data = await this.request<AMResponse>("/me/storefront");
      return data.data?.[0]?.id || "us";
    })();
    return this.storefront;
  }

  /**
   * Read a library collection up to `maxItems`. Apple serves library pages slowly
   * (1–2s each), so once the first page reports a total the rest load in parallel.
   */
  private async requestPages(path: string, params: Record<string, string>, maxItems = Infinity): Promise<AMResource[]> {
    const limit = Math.min(maxItems, LIBRARY_PAGE_SIZE);
    const first = await this.request<AMResponse>(path, { ...params, limit: String(limit) });
    const resources = [...(first.data ?? [])];
    const total = first.meta?.total;

    if (typeof total === "number" && resources.length === limit) {
      const start = Number(params.offset ?? 0);
      const offsets: number[] = [];
      for (let offset = start + limit; offset < Math.min(total, start + maxItems); offset += limit) {
        offsets.push(offset);
      }
      if (offsets.length >= MAX_PAGES) throw tooManyPages();
      const pages = await mapConcurrent(offsets, PAGE_CONCURRENCY, (offset) =>
        this.requestLaterPage(path, { ...params, offset: String(offset), limit: String(limit) }),
      );
      for (const page of pages) resources.push(...(page.data ?? []));
      return resources.slice(0, maxItems);
    }

    // No total, or a short first page: follow Apple's next links one page at a time.
    let next = first.next;
    for (let pageCount = 1; next && resources.length < maxItems; pageCount++) {
      if (pageCount >= MAX_PAGES) throw tooManyPages();
      const page = parseNextPage(next, String(limit));
      const data = await this.requestLaterPage(page.path, page.params);
      resources.push(...(data.data ?? []));
      next = data.next;
    }
    return resources.slice(0, maxItems);
  }

  /** A later page that 404s is past the end because the collection shrank since page 1. */
  private requestLaterPage(path: string, params: Record<string, string>): Promise<AMResponse> {
    return this.request<AMResponse>(path, params).catch((err: unknown): AMResponse => {
      if (isNotFound(err)) return {};
      throw err;
    });
  }

  // ── Playback: the Apple Music API has no playback control ──

  play = nativeOnly("Playback control");
  pause = nativeOnly("Playback control");
  resume = nativeOnly("Playback control");
  next = nativeOnly("Playback control");
  previous = nativeOnly("Playback control");
  seek = nativeOnly("Playback control");
  setVolume = nativeOnly("Volume control");
  getVolume = nativeOnly("Volume control");
  setShuffle = nativeOnly("Shuffle");
  getShuffle = nativeOnly("Shuffle");
  setRepeat = nativeOnly("Repeat mode");
  getRepeat = nativeOnly("Repeat mode");
  getStatus = nativeOnly("Playback status");
  getDevices = nativeOnly("Device listing");
  addToPlaylist = nativeOnly("Playlist editing");
  removeFromPlaylist = nativeOnly("Playlist editing");

  // ── Search (catalog) ──

  async search(query: string, types: SearchType[], limit = 20): Promise<SearchResults> {
    const typeMap: Record<SearchType, string> = {
      track: "songs",
      album: "albums",
      artist: "artists",
      playlist: "playlists",
    };

    const storefront = await this.getStorefront();
    const { results } = await this.request<AMResponse>(`/catalog/${storefront}/search`, {
      term: query,
      types: types.map((t) => typeMap[t]).join(","),
      limit: String(limit),
    });

    return {
      tracks: results?.songs?.data?.map(parseApiTrack) ?? [],
      albums: results?.albums?.data?.map(parseApiAlbum) ?? [],
      artists: results?.artists?.data?.map(parseApiArtist) ?? [],
      playlists: results?.playlists?.data?.map(parseApiPlaylist) ?? [],
    };
  }

  // ── Library ──

  async getPlaylists(): Promise<Playlist[]> {
    return (await this.requestPages("/me/library/playlists", {})).map(parseApiPlaylist);
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    const path = `/me/library/playlists/${encodeURIComponent(resolveApiLibraryId(playlistId, "Playlist"))}`;
    try {
      return (await this.requestPages(`${path}/tracks`, {})).map(parseApiTrack);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // A first-page 404 means an empty playlist or an unknown one; fetching the
      // playlist itself fails only in the second case.
      await this.request<AMResponse>(path);
      return [];
    }
  }

  async getPlaylistInfo(playlistId: string): Promise<PlaylistDetails> {
    const id = resolveApiLibraryId(playlistId, "Playlist");
    const [data, tracks] = await Promise.all([
      this.request<AMResponse>(`/me/library/playlists/${encodeURIComponent(id)}`),
      this.getPlaylistTracks(id),
    ]);
    const playlist = data.data?.[0];
    if (!playlist) {
      throw new ExternalServiceError(`Apple Music playlist not found: ${id}`);
    }

    return {
      ...parseApiPlaylist(playlist),
      trackCount: tracks.length,
      tracks,
      ...summarizePlaylistTracks(tracks),
    };
  }

  async getLibraryTracks(limit = 50, offset = 0): Promise<Track[]> {
    return (await this.requestPages("/me/library/songs", { offset: String(offset) }, limit)).map(parseApiTrack);
  }

  async getLibraryAlbums(limit = 50, offset = 0): Promise<Album[]> {
    return (await this.requestPages("/me/library/albums", { offset: String(offset) }, limit)).map(parseApiAlbum);
  }
}
