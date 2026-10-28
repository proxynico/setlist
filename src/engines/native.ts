import { $ } from "bun";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
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
  DeviceKind,
  RepeatMode,
  Replay,
  StatusOptions,
} from "../lib/types";
import { buildIdentity, resolveRawId } from "../lib/entities";
import { ExternalServiceError, MusicError, UnsupportedOperationError } from "../lib/errors";
import { summarizePlaylistTracks } from "../lib/library-audit";

/**
 * macOS native engine — controls Music.app via JXA (JavaScript for Automation).
 * No auth needed, no rate limits. macOS only.
 *
 * Every Apple Event costs ~25ms, so reads fetch whole collections with bulk
 * property getters (`tracks.name()`) or one `properties()` record per track,
 * never one event per field.
 */

const SYSTEM_MUSIC_APP_PATH = "/System/Applications/Music.app";

export function createMusicApplicationSource(appPath = SYSTEM_MUSIC_APP_PATH): string {
  return existsSync(appPath) ? `Application(${JSON.stringify(appPath)})` : 'Application("Music")';
}

const MUSIC_APP = createMusicApplicationSource();

export function shouldRetryAfterMusicError(error: string): boolean {
  return error.includes("not running") || error.includes("-1728") || isMusicScriptingUnavailableError(error);
}

function isMusicScriptingUnavailableError(error: string): boolean {
  return error.includes("-1701") || error.includes("-10827") || error.includes("Parameter is missing");
}

export function musicScriptingUnavailableRecovery(): string {
  return [
    "If you are running from Codex/cmux, rerun the whole `setlist ...` command outside the sandbox/escalated so it can attach to Music.app.",
    "If it still fails outside the sandbox, grant the calling app Automation permission for Music.app in System Settings.",
  ].join(" ");
}

async function osascript(script: string) {
  const result = await $`osascript -l JavaScript -e ${script}`.quiet().nothrow();
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

async function ensureMusicRunning(): Promise<void> {
  const isRunning = async () => (await osascript(`${MUSIC_APP}.running()`)).stdout === "true";
  if (await isRunning()) return;

  // Launch hidden — no window popping up
  await osascript(`${MUSIC_APP}.launch()`);
  if (MUSIC_APP !== 'Application("Music")') {
    await $`open -gj ${SYSTEM_MUSIC_APP_PATH}`.quiet().nothrow();
  }

  // Wait up to 5s for it to be ready
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(500);
    if (await isRunning()) return;
  }
  throw new ExternalServiceError("Music.app failed to start.", "Try opening Music.app manually.");
}

function scriptError(stderr: string, cause?: unknown): ExternalServiceError {
  if (isMusicScriptingUnavailableError(stderr)) {
    return new ExternalServiceError(
      "Music.app could not be launched or controlled by this process.",
      musicScriptingUnavailableRecovery(),
      cause,
    );
  }
  // "execution error: Error: Error: Playlist not found (-2700)" → "Playlist not found"
  const message = stderr.replace(/^.*?execution error: (?:Error: )*/s, "").replace(/ \(-?\d+\)$/, "");
  return new ExternalServiceError(`Music.app: ${message || stderr}`);
}

/**
 * Run a JXA script with `music` bound to Music.app; launch Music.app and retry once if it isn't ready.
 * Edits launch Music.app first and pass `retry: false`, since a retry could repeat a partial edit.
 */
async function jxa(body: string, { retry = true } = {}): Promise<string> {
  const script = `const music = ${MUSIC_APP};\n${body}`;
  let result = await osascript(script);
  if (!result.ok && retry && shouldRetryAfterMusicError(result.stderr)) {
    try {
      await ensureMusicRunning();
    } catch (launchErr) {
      if (isMusicScriptingUnavailableError(result.stderr)) throw scriptError(result.stderr, launchErr);
      throw launchErr;
    }
    result = await osascript(script);
  }
  if (!result.ok) throw scriptError(result.stderr);
  return result.stdout;
}

async function jxaJson<T>(body: string): Promise<T> {
  return JSON.parse(await jxa(`JSON.stringify((() => {\n${body}\n})());`));
}

// JXA helpers for scripts that read tracks. `readTracks` bulk-reads a track
// collection in eight Apple Events; `findPlaylist` fails clearly on unknown IDs;
// `artworkData` returns an item's first artwork as a data literal, or "".
const JXA_HELPERS = `
function readTracks(tracks) {
  if (tracks.length === 0) return [];
  const persistentId = tracks.persistentID(), name = tracks.name(), artist = tracks.artist(), album = tracks.album(),
    duration = tracks.duration(), trackNumber = tracks.trackNumber(), genre = tracks.genre(), year = tracks.year();
  return persistentId.map((id, i) => ({
    persistentId: id, name: name[i], artist: artist[i], album: album[i],
    duration: duration[i], trackNumber: trackNumber[i], genre: genre[i], year: year[i],
  }));
}
function trackFromProperties(p) {
  return {
    persistentId: p.persistentID, name: p.name, artist: p.artist, album: p.album,
    duration: p.duration, trackNumber: p.trackNumber, genre: p.genre, year: p.year,
  };
}
function findPlaylist(id) {
  const matches = music.playlists.whose({ persistentID: id });
  if (matches.length === 0) throw new Error("Playlist not found: " + id);
  return matches[0];
}
function artworkData(item) {
  try {
    return item.artworks.length > 0 ? String(item.artworks[0].rawData()) : "";
  } catch (e) {
    return ""; // Artwork is best effort.
  }
}
`;

/** Music.app hands artwork to JXA as an AppleScript data literal: `'tdta'($FFD8…$)`. */
export function decodeArtworkData(literal: string): Buffer | undefined {
  const hex = /^'.{4}'\(\$([0-9A-Fa-f]+)\$\)$/s.exec(literal)?.[1];
  return hex ? Buffer.from(hex, "hex") : undefined;
}

/** Save artwork as a PNG in the per-user temp dir; Music.app stores JPEG or PNG. */
async function saveArtworkPng({
  literal,
  name,
  maxPixels,
}: {
  literal: string;
  name: string;
  maxPixels?: number;
}): Promise<string | undefined> {
  const bytes = decodeArtworkData(literal);
  if (!bytes) return undefined;
  const source = join(tmpdir(), `${name}.source`);
  const path = join(tmpdir(), `${name}.png`);
  await Bun.write(source, bytes);
  const resize = maxPixels ? ["-Z", String(maxPixels)] : [];
  const result = await $`sips -s format png ${resize} ${source} --out ${path}`.quiet().nothrow();
  await rm(source, { force: true });
  return result.exitCode === 0 ? path : undefined;
}

// Big enough for a crisp thumbnail on a Retina terminal, small enough to send inline.
const STATUS_ARTWORK_PIXELS = 320;

interface NativeTrackData {
  persistentId: string;
  name?: string;
  artist?: string;
  album?: string;
  duration?: number;
  trackNumber?: number;
  genre?: string;
  year?: number;
}

function parseTrack(raw: NativeTrackData): Track {
  return {
    ...buildIdentity({ source: "native", persistentId: raw.persistentId }),
    name: raw.name ?? "Unknown",
    artist: raw.artist ?? "Unknown",
    album: raw.album ?? "",
    duration: raw.duration ?? 0,
    trackNumber: raw.trackNumber || undefined,
    genre: raw.genre || undefined,
    year: raw.year || undefined,
  };
}

function resolvePersistentId(id: string, label: "Track" | "Playlist"): string {
  return resolveRawId(id, {
    source: "native",
    kind: "persistent",
    label,
    description: "a native persistent ID",
    hint: `Use \`setlist --engine native ... --json\` and pass the ${label.toLowerCase()}'s \`persistentId\` field for native-only commands.`,
  });
}

function normalizeDeviceKind(raw: string | undefined): DeviceKind {
  // Music.app reports e.g. "computer", "Bluetooth device", "AirPlay device", "Apple TV", "HomePod", "unknown".
  const kind = raw?.toLowerCase() ?? "unknown";
  if (kind.includes("bluetooth")) return "bluetooth";
  if (kind === "computer") return "computer";
  if (kind === "unknown") return "unknown";
  return "airplay";
}

export function deriveAlbumsFromTracks(tracks: Track[], limit = 20): Album[] {
  const albums = new Map<string, Album>();
  for (const track of tracks) {
    const key = `${track.album}::${track.artist}`;
    if (!track.album || albums.has(key)) continue;
    albums.set(key, {
      ...buildIdentity({ source: "native", derivedId: `album:${key}` }),
      name: track.album,
      artist: track.artist,
      year: track.year,
      genre: track.genre,
    });
  }
  return [...albums.values()].slice(0, limit);
}

export function deriveArtistsFromTracks(tracks: Track[], limit = 20): Artist[] {
  const artists = new Map<string, Artist>();
  for (const track of tracks) {
    if (artists.has(track.artist)) continue;
    artists.set(track.artist, {
      ...buildIdentity({ source: "native", derivedId: `artist:${track.artist}` }),
      name: track.artist,
      genre: track.genre,
    });
  }
  return [...artists.values()].slice(0, limit);
}

interface AlbumColumns {
  album: string[];
  artist: string[];
  year: number[];
  genre: string[];
}

function groupAlbums(columns: AlbumColumns): Album[] {
  const albums = new Map<string, Album & { trackCount: number }>();
  for (const [i, name] of columns.album.entries()) {
    if (!name) continue;
    const artist = columns.artist[i];
    const key = `${name}::${artist}`;
    const album = albums.get(key);
    if (album) {
      album.trackCount += 1;
      continue;
    }
    albums.set(key, {
      ...buildIdentity({ source: "native", derivedId: `album:${key}` }),
      name,
      artist,
      trackCount: 1,
      year: columns.year[i] || undefined,
      genre: columns.genre[i] || undefined,
    });
  }
  return [...albums.values()];
}

export class NativeEngine implements MusicEngine {
  async play(query?: string): Promise<void> {
    if (!query) {
      await jxa("music.play();");
      return;
    }

    const played = await jxa(`
      const found = music.search(music.libraryPlaylists[0], { for: ${JSON.stringify(query)} }) || [];
      if (found.length > 0) music.play(found[0]);
      found.length > 0;
    `);
    if (played !== "true") {
      throw new MusicError(`No library tracks match "${query}"`, {
        code: "not_found",
        hint: "Check the spelling, or find a track with `setlist --engine native search track <query>`.",
      });
    }
  }

  async pause(): Promise<void> {
    await jxa("music.pause();");
  }

  async resume(): Promise<void> {
    await jxa("music.play();");
  }

  async next(): Promise<void> {
    await jxa("music.nextTrack();");
  }

  async previous(): Promise<void> {
    await jxa("music.previousTrack();");
  }

  async seek(seconds: number): Promise<void> {
    await jxa(`music.playerPosition = ${seconds};`);
  }

  async setVolume(level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    await jxa(`music.soundVolume = ${clamped};`);
  }

  async getVolume(): Promise<number> {
    return Number.parseInt(await jxa("music.soundVolume();"), 10);
  }

  async setShuffle(enabled: boolean): Promise<void> {
    await jxa(`music.shuffleEnabled = ${enabled};`);
  }

  async getShuffle(): Promise<boolean> {
    return (await jxa("music.shuffleEnabled();")) === "true";
  }

  async setRepeat(mode: RepeatMode): Promise<void> {
    await jxa(`music.songRepeat = ${JSON.stringify(mode)};`);
  }

  async getRepeat(): Promise<RepeatMode> {
    return normalizeRepeat(await jxa("music.songRepeat();"));
  }

  async getStatus({ artwork = false }: StatusOptions = {}): Promise<PlaybackState> {
    const { artworkLiteral, ...raw } = await jxaJson<
      Omit<PlaybackState, "track" | "repeatMode" | "artworkPath"> & {
        track: NativeTrackData | null;
        repeatMode: string;
        artworkLiteral: string;
      }
    >(`
      ${JXA_HELPERS}
      const stateMap = { playing: "playing", paused: "paused", stopped: "stopped", "fast forwarding": "playing", rewinding: "playing" };
      const state = stateMap[music.playerState()] || "stopped";
      const active = state !== "stopped";
      return {
        state,
        track: active ? trackFromProperties(music.currentTrack.properties()) : null,
        position: active ? music.playerPosition() : 0,
        volume: music.soundVolume(),
        shuffleEnabled: music.shuffleEnabled(),
        repeatMode: music.songRepeat(),
        artworkLiteral: active && ${artwork} ? artworkData(music.currentTrack) : "",
      };
    `);

    const artworkPath = artworkLiteral
      ? await saveArtworkPng({ literal: artworkLiteral, name: "setlist-now-playing", maxPixels: STATUS_ARTWORK_PIXELS })
      : undefined;
    return {
      ...raw,
      track: raw.track ? parseTrack(raw.track) : null,
      repeatMode: normalizeRepeat(raw.repeatMode),
      artworkPath,
    };
  }

  async search(query: string, types: SearchType[], limit = 20): Promise<SearchResults> {
    const searchTracks = async () =>
      (
        await jxaJson<NativeTrackData[]>(`
          ${JXA_HELPERS}
          const found = music.search(music.libraryPlaylists[0], { for: ${JSON.stringify(query)} }) || [];
          return found.slice(0, ${limit}).map((t) => trackFromProperties(t.properties()));
        `)
      ).map(parseTrack);
    const searchPlaylists = async () => {
      const q = query.toLowerCase();
      return (await this.getPlaylists()).filter((p) => p.name.toLowerCase().includes(q)).slice(0, limit);
    };

    // Music.app search only returns tracks; albums and artists are derived from them.
    const [tracks, playlists] = await Promise.all([
      types.some((type) => type !== "playlist") ? searchTracks() : [],
      types.includes("playlist") ? searchPlaylists() : [],
    ]);

    return {
      tracks: types.includes("track") ? tracks : [],
      albums: types.includes("album") ? deriveAlbumsFromTracks(tracks, limit) : [],
      artists: types.includes("artist") ? deriveArtistsFromTracks(tracks, limit) : [],
      playlists,
    };
  }

  async getPlaylists(): Promise<Playlist[]> {
    const raw = await jxaJson<Array<{ persistentId: string; name: string; trackCount: number }>>(`
      const playlists = music.playlists;
      const kinds = playlists.specialKind(), ids = playlists.persistentID(), names = playlists.name();
      const result = [];
      for (let i = 0; i < ids.length; i++) {
        // Skip Music's built-in playlists (Library, Music, Purchased...)
        if (kinds[i] === "none" || kinds[i] === "folder") {
          result.push({ persistentId: ids[i], name: names[i], trackCount: playlists[i].tracks.length });
        }
      }
      return result;
    `);
    return raw.map((p) => ({
      ...buildIdentity({ source: "native", persistentId: p.persistentId }),
      name: p.name,
      trackCount: p.trackCount,
    }));
  }

  async getPlaylistInfo(playlistId: string): Promise<PlaylistDetails> {
    const persistentId = resolvePersistentId(playlistId, "Playlist");
    const info = await jxaJson<{
      name: string;
      description: string;
      tracks: NativeTrackData[];
      artworkLiteral: string;
    }>(`
      ${JXA_HELPERS}
      const p = findPlaylist(${JSON.stringify(persistentId)});
      return { name: p.name(), description: p.description() || "", tracks: readTracks(p.tracks), artworkLiteral: artworkData(p) };
    `);

    const tracks = info.tracks.map(parseTrack);
    return {
      ...buildIdentity({ source: "native", persistentId }),
      name: info.name,
      description: info.description || undefined,
      trackCount: tracks.length,
      artworkPath: info.artworkLiteral
        ? await saveArtworkPng({ literal: info.artworkLiteral, name: `setlist-artwork-${persistentId}` })
        : undefined,
      tracks,
      ...summarizePlaylistTracks(tracks),
    };
  }

  async addToPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
    const playlist = resolvePersistentId(playlistId, "Playlist");
    const tracks = trackIds.map((id) => resolvePersistentId(id, "Track"));
    // Resolve every track before adding any, so a bad ID leaves the playlist unchanged.
    await ensureMusicRunning();
    await jxa(
      `
      ${JXA_HELPERS}
      const playlist = findPlaylist(${JSON.stringify(playlist)});
      const library = music.libraryPlaylists[0];
      const tracks = ${JSON.stringify(tracks)}.map((id) => {
        const matches = library.tracks.whose({ persistentID: id });
        if (matches.length === 0) throw new Error("Track not found: " + id);
        return matches[0];
      });
      for (const track of tracks) music.duplicate(track, { to: playlist });
    `,
      { retry: false },
    );
  }

  async removeFromPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
    const playlist = resolvePersistentId(playlistId, "Playlist");
    const tracks = trackIds.map((id) => resolvePersistentId(id, "Track"));
    await ensureMusicRunning();
    await jxa(
      `
      ${JXA_HELPERS}
      const playlist = findPlaylist(${JSON.stringify(playlist)});
      const tracks = ${JSON.stringify(tracks)}.map((id) => {
        const matches = playlist.tracks.whose({ persistentID: id });
        if (matches.length === 0) throw new Error("Track not found in playlist: " + id);
        return matches[0];
      });
      for (const track of tracks) track.delete();
    `,
      { retry: false },
    );
  }

  async getReplay(): Promise<Replay> {
    throw new UnsupportedOperationError(
      "Replay needs the Apple Music API.",
      "Sign in with `setlist auth import --browser safari`, then use `--engine auto` or `--engine api`.",
    );
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    const persistentId = resolvePersistentId(playlistId, "Playlist");
    const raw = await jxaJson<NativeTrackData[]>(`
      ${JXA_HELPERS}
      return readTracks(findPlaylist(${JSON.stringify(persistentId)}).tracks);
    `);
    return raw.map(parseTrack);
  }

  async getLibraryTracks(limit = 50, offset = 0): Promise<Track[]> {
    const raw = await jxaJson<NativeTrackData[]>(`
      ${JXA_HELPERS}
      return readTracks(music.libraryPlaylists[0].tracks).slice(${offset}, ${offset + limit});
    `);
    return raw.map(parseTrack);
  }

  async getLibraryAlbums(limit = 50, offset = 0): Promise<Album[]> {
    const columns = await jxaJson<AlbumColumns>(`
      const tracks = music.libraryPlaylists[0].tracks;
      if (tracks.length === 0) return { album: [], artist: [], year: [], genre: [] };
      return { album: tracks.album(), artist: tracks.artist(), year: tracks.year(), genre: tracks.genre() };
    `);
    return groupAlbums(columns).slice(offset, offset + limit);
  }

  async getDevices(): Promise<Device[]> {
    const raw = await jxaJson<{ id: string[]; name: string[]; kind: string[]; active: boolean[] }>(`
      const devices = music.airplayDevices;
      if (devices.length === 0) return { id: [], name: [], kind: [], active: [] };
      return { id: devices.persistentID(), name: devices.name(), kind: devices.kind(), active: devices.selected() };
    `);
    return raw.id.map((id, i) => ({
      id,
      name: raw.name[i],
      kind: normalizeDeviceKind(raw.kind[i]),
      active: raw.active[i],
    }));
  }
}

function normalizeRepeat(raw: string): RepeatMode {
  return raw === "one" || raw === "all" ? raw : "off";
}
