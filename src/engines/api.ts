import type {
  EngineCapabilities,
  MusicEngine,
  Track,
  Album,
  Artist,
  Playlist,
  PlaylistDetails,
  PlaybackState,
  SearchResults,
  SearchType,
  Device,
  CliConfig,
} from "../lib/types";
import { getMediaUserToken, loadConfig } from "../lib/config";
import { buildIdentity, parseEntityRef, validateRawId } from "../lib/entities";
import { AuthError, ExternalServiceError, UnsupportedOperationError } from "../lib/errors";

const AMP_API_BASE = "https://amp-api.music.apple.com/v1";
const WEBPLAYER_TOKEN_URL = "https://music.apple.com";
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Apple Music web API engine.
 * Uses the media-user-token from browser cookies to authenticate against
 * Apple's internal amp-api.music.apple.com endpoints.
 *
 * This is the Apple Music equivalent of Spogo's cookie-based Spotify approach.
 * No official API key needed — just browser cookies.
 */

// The Apple Music web player embeds a JWT developer token in its JS bundle.
// We extract it once and cache it with a TTL.
let cachedDevToken: string | null = null;
let cachedDevTokenExpiry = 0;
let cachedStorefront: string | null = null;

const DEV_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const JWT_PATTERN = /eyJhbGciOi[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return atob(padded);
}

function isValidJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(decodeBase64Url(parts[0]));
    return typeof header.alg === "string" && typeof header.typ === "string";
  } catch {
    return false;
  }
}

function extractJwt(text: string): string | null {
  const match = text.match(JWT_PATTERN);
  if (!match) return null;
  return isValidJwt(match[0]) ? match[0] : null;
}

async function fetchWithTimeout(url: string, label: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ExternalServiceError(`${label} failed.`, "Check your network connection and try again.", err);
  }
}

async function getWebPlayerDevToken(): Promise<string> {
  if (cachedDevToken && Date.now() < cachedDevTokenExpiry) return cachedDevToken;

  // Fetch the Apple Music web player and extract the embedded token
  const res = await fetchWithTimeout(WEBPLAYER_TOKEN_URL, "Apple Music web player request");
  if (!res.ok) {
    throw new ExternalServiceError(`Apple Music web player error: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();

  // The token is embedded in the page's JS assets. Look for the JWT pattern.
  // Apple embeds it as a constant in their webpack bundles.
  const token = extractJwt(html);
  if (token) {
    cachedDevToken = token;
    cachedDevTokenExpiry = Date.now() + DEV_TOKEN_TTL_MS;
    return cachedDevToken;
  }

  // If not in the main HTML, try fetching JS assets
  // Match both absolute (https://...) and relative (/assets/...) script src paths
  const absoluteUrls = html.match(/https:\/\/[^"']+\.js/g) || [];
  const relativeUrls = (html.match(/src="(\/[^"]+\.js)"/g) || []).map(
    (m: string) => `https://music.apple.com${m.match(/src="([^"]+)"/)?.[1]}`,
  );
  const jsUrls = [...absoluteUrls, ...relativeUrls];
  for (const url of jsUrls.slice(0, 10)) {
    try {
      const jsRes = await fetchWithTimeout(url, "Apple Music JavaScript bundle request");
      if (!jsRes.ok) continue;
      const js = await jsRes.text();
      const jsToken = extractJwt(js);
      if (jsToken) {
        cachedDevToken = jsToken;
        cachedDevTokenExpiry = Date.now() + DEV_TOKEN_TTL_MS;
        return cachedDevToken;
      }
    } catch {}
  }

  throw new ExternalServiceError(
    "Could not extract the Apple Music developer token from the web player.",
    "Apple may have changed the web player. Use `--engine native` if you only need Music.app control.",
  );
}

async function apiRequest<T>(path: string, params?: Record<string, string>): Promise<T> {
  const mediaUserToken = await getMediaUserToken();
  if (!mediaUserToken) {
    throw new AuthError(
      "No Apple Music media-user-token is configured.",
      "Run `setlist auth import --browser safari` or `setlist auth token <token>`.",
    );
  }

  const devToken = await getWebPlayerDevToken();
  const url = new URL(`${AMP_API_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetchWithTimeout(url.toString(), "Apple Music API request", {
    headers: {
      Authorization: `Bearer ${devToken}`,
      "Media-User-Token": mediaUserToken,
      Origin: "https://music.apple.com",
      Referer: "https://music.apple.com/",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(
        "Apple Music authentication failed. The media-user-token may be expired.",
        "Re-import it with `setlist auth import --browser safari`.",
      );
    }
    throw new ExternalServiceError(`Apple Music API error: ${res.status} ${res.statusText}`);
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
  relationships?: Record<string, { data: AMResource[] }>;
}

interface AMResponse {
  results?: {
    songs?: { data: AMResource[] };
    albums?: { data: AMResource[] };
    artists?: { data: AMResource[] };
    playlists?: { data: AMResource[] };
  };
  data?: AMResource[];
  next?: string;
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

function strArray(val: unknown): string[] {
  return Array.isArray(val) ? val.filter((v): v is string => typeof v === "string") : [];
}

function recordOrEmpty(val: unknown): Record<string, unknown> {
  return val && typeof val === "object" && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}

function extractIds(r: AMResource): { catalogId?: string; libraryId?: string } {
  const a = recordOrEmpty(r.attributes);
  const playParams = recordOrEmpty(a.playParams);
  const catalogId =
    str(playParams.catalogId) ||
    str(playParams.id) ||
    str(playParams.globalId) ||
    (r.type === "songs" || r.type === "albums" || r.type === "artists" || r.type === "playlists" ? r.id : undefined);
  const libraryId = r.type.startsWith("library-") ? r.id : undefined;
  return { catalogId: catalogId || undefined, libraryId };
}

function resolveApiLibraryId(id: string, label: string): string {
  const ref = parseEntityRef(id);
  if (ref) {
    if (ref.source !== "api" || ref.kind !== "library") {
      throw new UnsupportedOperationError(
        `${label} ${id} is not an Apple Music library ID`,
        `Use \`setlist --engine api ... --json\` and pass the ${label.toLowerCase()}'s \`libraryId\` field.`,
      );
    }
    return validateRawId(ref.value, label);
  }
  return validateRawId(id, label);
}

function parseYear(releaseDate: unknown): number | undefined {
  if (typeof releaseDate !== "string" || releaseDate.length < 4) return undefined;
  const year = parseInt(releaseDate.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : undefined;
}

function parseApiTrack(r: AMResource): Track {
  const a = recordOrEmpty(r.attributes);
  const { catalogId, libraryId } = extractIds(r);
  return {
    ...buildIdentity({ source: "api", libraryId, catalogId }),
    name: str(a.name, "Unknown"),
    artist: str(a.artistName, "Unknown"),
    album: str(a.albumName),
    duration: Math.round(num(a.durationInMillis) / 1000),
    trackNumber: num(a.trackNumber) || undefined,
    genre: strArray(a.genreNames)[0] || undefined,
    year: parseYear(a.releaseDate),
    artworkUrl: formatArtwork(a.artwork),
  };
}

function parseApiAlbum(r: AMResource): Album {
  const a = recordOrEmpty(r.attributes);
  const { catalogId, libraryId } = extractIds(r);
  return {
    ...buildIdentity({ source: "api", libraryId, catalogId }),
    name: str(a.name, "Unknown"),
    artist: str(a.artistName, "Unknown"),
    trackCount: num(a.trackCount),
    year: parseYear(a.releaseDate),
    genre: strArray(a.genreNames)[0] || undefined,
    artworkUrl: formatArtwork(a.artwork),
  };
}

function parseApiArtist(r: AMResource): Artist {
  const a = recordOrEmpty(r.attributes);
  const { catalogId, libraryId } = extractIds(r);
  return {
    ...buildIdentity({ source: "api", libraryId, catalogId }),
    name: str(a.name, "Unknown"),
    genre: strArray(a.genreNames)[0] || undefined,
    artworkUrl: formatArtwork(a.artwork),
  };
}

function parseApiPlaylist(r: AMResource): Playlist {
  const a = recordOrEmpty(r.attributes);
  const { catalogId, libraryId } = extractIds(r);
  const desc = recordOrEmpty(a.description);
  return {
    ...buildIdentity({ source: "api", libraryId, catalogId }),
    name: str(a.name, "Unknown"),
    description: str(desc.short) || undefined,
    trackCount: 0,
  };
}

function formatArtwork(artwork: unknown): string | undefined {
  const obj = recordOrEmpty(artwork);
  const url = str(obj.url);
  if (!url) return undefined;
  return url.replace("{w}", "300").replace("{h}", "300");
}

function parseNextPage(next: string): ApiPage {
  const url = new URL(next, AMP_API_BASE);
  const path = url.pathname.startsWith("/v1/") ? url.pathname.slice(3) : url.pathname;
  return {
    path,
    params: Object.fromEntries(url.searchParams.entries()),
  };
}

export class ApiEngine implements MusicEngine {
  name = "api";
  capabilities: EngineCapabilities = {
    playback: false,
    queue: false,
    playlistMutation: false,
    devices: false,
    catalogSearch: true,
    libraryRead: true,
    shuffle: false,
    repeat: false,
  };

  constructor(private deps: ApiEngineDeps = {}) {}

  private request<T>(path: string, params?: Record<string, string>): Promise<T> {
    return (this.deps.request ?? apiRequest)<T>(path, params);
  }

  private loadRuntimeConfig(): Promise<CliConfig> {
    return (this.deps.configLoader ?? loadConfig)();
  }

  private async getStorefront(): Promise<string> {
    if (cachedStorefront) return cachedStorefront;
    const config = await this.loadRuntimeConfig();
    if (config.storefront && config.storefront !== "auto") {
      cachedStorefront = config.storefront;
      return cachedStorefront;
    }

    const data = await this.request<AMResponse>("/me/storefront");
    const storefront = data.data?.[0]?.id;
    cachedStorefront = storefront || "us";
    return cachedStorefront;
  }

  private async requestAllData(
    path: string,
    params: Record<string, string>,
    maxItems = Infinity,
  ): Promise<AMResource[]> {
    const resources: AMResource[] = [];
    let page: ApiPage | null = { path, params };
    let pageCount = 0;

    while (page && resources.length < maxItems) {
      pageCount++;
      if (pageCount > 1000) {
        throw new ExternalServiceError(
          "Apple Music API pagination exceeded 1000 pages.",
          "The API returned too many continuation links; try a lower limit.",
        );
      }

      const data: AMResponse = await this.request<AMResponse>(page.path, page.params);
      resources.push(...(data.data || []));
      page = data.next ? parseNextPage(data.next) : null;
    }

    return resources.slice(0, maxItems);
  }

  // ── Playback (not supported via API — delegate to native) ──
  // The Apple Music API is a catalog/library API, not a playback control API.
  // Playback must go through Music.app (native engine).

  async play(_query?: string): Promise<void> {
    throw new UnsupportedOperationError(
      "Playback control requires the native engine.",
      "Use `setlist --engine native play`.",
    );
  }

  async pause(): Promise<void> {
    throw new UnsupportedOperationError(
      "Playback control requires the native engine.",
      "Use `setlist --engine native pause`.",
    );
  }

  async resume(): Promise<void> {
    throw new UnsupportedOperationError(
      "Playback control requires the native engine.",
      "Use `setlist --engine native resume`.",
    );
  }

  async next(): Promise<void> {
    throw new UnsupportedOperationError(
      "Playback control requires the native engine.",
      "Use `setlist --engine native next`.",
    );
  }

  async previous(): Promise<void> {
    throw new UnsupportedOperationError(
      "Playback control requires the native engine.",
      "Use `setlist --engine native prev`.",
    );
  }

  async seek(_seconds: number): Promise<void> {
    throw new UnsupportedOperationError("Playback control requires the native engine.");
  }

  async setVolume(_level: number): Promise<void> {
    throw new UnsupportedOperationError("Volume control requires the native engine.");
  }

  async getVolume(): Promise<number> {
    throw new UnsupportedOperationError("Volume requires the native engine.");
  }

  async setShuffle(_enabled: boolean): Promise<void> {
    throw new UnsupportedOperationError("Shuffle requires the native engine.");
  }

  async getShuffle(): Promise<boolean> {
    throw new UnsupportedOperationError("Shuffle requires the native engine.");
  }

  async setRepeat(_mode: "off" | "one" | "all"): Promise<void> {
    throw new UnsupportedOperationError("Repeat mode requires the native engine.");
  }

  async getRepeat(): Promise<"off" | "one" | "all"> {
    throw new UnsupportedOperationError("Repeat mode requires the native engine.");
  }

  async getStatus(): Promise<PlaybackState> {
    throw new UnsupportedOperationError("Playback status requires the native engine.");
  }

  // ── Search (catalog) ──

  async search(query: string, types: SearchType[], limit = 20): Promise<SearchResults> {
    const typeMap: Record<SearchType, string> = {
      track: "songs",
      album: "albums",
      artist: "artists",
      playlist: "playlists",
    };

    const amTypes = (types.length > 0 ? types : (["track", "album", "artist"] as SearchType[]))
      .map((t) => typeMap[t])
      .join(",");

    const storefront = await this.getStorefront();
    const data = await this.request<AMResponse>(`/catalog/${storefront}/search`, {
      term: query,
      types: amTypes,
      limit: String(limit),
    });

    const results: SearchResults = { tracks: [], albums: [], artists: [], playlists: [] };

    if (data.results?.songs?.data) {
      results.tracks = data.results.songs.data.map(parseApiTrack);
    }
    if (data.results?.albums?.data) {
      results.albums = data.results.albums.data.map(parseApiAlbum);
    }
    if (data.results?.artists?.data) {
      results.artists = data.results.artists.data.map(parseApiArtist);
    }
    if (data.results?.playlists?.data) {
      results.playlists = data.results.playlists.data.map(parseApiPlaylist);
    }

    return results;
  }

  // ── Queue (not supported via API) ──

  async addToQueue(_trackId: string): Promise<void> {
    throw new UnsupportedOperationError("Queue management requires the native engine.");
  }

  // ── Library ──

  async getPlaylists(): Promise<Playlist[]> {
    const data = await this.requestAllData("/me/library/playlists", {
      limit: "100",
    });
    return data.map(parseApiPlaylist);
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    const apiPlaylistId = resolveApiLibraryId(playlistId, "Playlist");
    const data = await this.requestAllData(`/me/library/playlists/${encodeURIComponent(apiPlaylistId)}/tracks`, {
      limit: "100",
    });
    return data.map(parseApiTrack);
  }

  async getPlaylistInfo(playlistId: string): Promise<PlaylistDetails> {
    const apiPlaylistId = resolveApiLibraryId(playlistId, "Playlist");
    const data = await this.request<AMResponse>(`/me/library/playlists/${encodeURIComponent(apiPlaylistId)}`, {});
    const playlist = data.data?.[0];
    if (!playlist) {
      throw new ExternalServiceError(`Apple Music playlist not found: ${apiPlaylistId}`);
    }
    const a = recordOrEmpty(playlist?.attributes);
    const tracks = await this.getPlaylistTracks(apiPlaylistId);
    const playParams = recordOrEmpty(a.playParams);
    const desc = recordOrEmpty(a.description);

    const artistCounts = new Map<string, number>();
    const genreCounts = new Map<string, number>();
    for (const t of tracks) {
      artistCounts.set(t.artist, (artistCounts.get(t.artist) || 0) + 1);
      genreCounts.set(t.genre || "Unknown", (genreCounts.get(t.genre || "Unknown") || 0) + 1);
    }

    return {
      ...buildIdentity({
        source: "api",
        libraryId: apiPlaylistId,
        catalogId: str(playParams.catalogId) || str(playParams.globalId) || undefined,
      }),
      name: str(a.name, "Unknown"),
      description: str(desc.short) || undefined,
      trackCount: tracks.length,
      totalDuration: tracks.reduce((sum, t) => sum + t.duration, 0),
      artworkUrl: formatArtwork(a.artwork),
      tracks,
      topArtists: Array.from(artistCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => ({ name, count })),
      genres: Array.from(genreCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, count })),
    };
  }

  async addToPlaylist(_playlistId: string, _trackIds: string[]): Promise<void> {
    throw new UnsupportedOperationError(
      "Playlist editing via API is not implemented.",
      "Use `--engine native` with native persistent IDs.",
    );
  }

  async removeFromPlaylist(_playlistId: string, _trackIds: string[]): Promise<void> {
    throw new UnsupportedOperationError(
      "Playlist editing via API is not implemented.",
      "Use `--engine native` with native persistent IDs.",
    );
  }

  async getLibraryTracks(limit = 50, offset = 0): Promise<Track[]> {
    const data = await this.requestAllData(
      "/me/library/songs",
      {
        limit: String(limit),
        offset: String(offset),
      },
      limit,
    );
    return data.map(parseApiTrack);
  }

  async getLibraryAlbums(limit = 50, offset = 0): Promise<Album[]> {
    const data = await this.requestAllData(
      "/me/library/albums",
      {
        limit: String(limit),
        offset: String(offset),
      },
      limit,
    );
    return data.map(parseApiAlbum);
  }

  // ── Devices (not available via API) ──

  async getDevices(): Promise<Device[]> {
    throw new UnsupportedOperationError("Device listing requires the native engine.");
  }
}
