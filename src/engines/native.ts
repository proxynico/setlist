import { $ } from "bun";
import { existsSync } from "node:fs";
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
} from "../lib/types";
import { buildIdentity, parseEntityRef, validateRawId } from "../lib/entities";
import { ExternalServiceError, UnsupportedOperationError } from "../lib/errors";
import type { DeviceKind } from "../lib/types";

/**
 * macOS native engine — controls Music.app via JXA (JavaScript for Automation).
 * No auth needed, no rate limits. macOS only.
 */

const SYSTEM_MUSIC_APP_PATH = "/System/Applications/Music.app";

export function createMusicApplicationSource(appPath = SYSTEM_MUSIC_APP_PATH): string {
  return existsSync(appPath) ? `Application(${JSON.stringify(appPath)})` : 'Application("Music")';
}

function resolveMusicApplicationReferences(script: string): string {
  return script.replaceAll('Application("Music")', createMusicApplicationSource());
}

export function shouldRetryAfterMusicError(error: string): boolean {
  return (
    error.includes("not running") ||
    error.includes("-1728") ||
    error.includes("-1701") ||
    error.includes("-10827") ||
    error.includes("Parameter is missing")
  );
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

async function ensureMusicRunning(): Promise<void> {
  const musicApp = createMusicApplicationSource();
  const check = await $`osascript -l JavaScript -e ${`${musicApp}.running()`}`.quiet().nothrow();
  if (check.stdout.toString().trim() === "true") return;

  // Launch hidden — no window popping up
  await $`osascript -l JavaScript -e ${`const app = ${musicApp}; app.launch()`}`.quiet().nothrow();
  if (musicApp !== 'Application("Music")') {
    await $`open -gj ${SYSTEM_MUSIC_APP_PATH}`.quiet().nothrow();
  }

  // Wait up to 5s for it to be ready
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(500);
    const ready = await $`osascript -l JavaScript -e ${`${musicApp}.running()`}`.quiet().nothrow();
    if (ready.stdout.toString().trim() === "true") return;
  }
  throw new ExternalServiceError("Music.app failed to start.", "Try opening Music.app manually.");
}

async function jxa(script: string): Promise<string> {
  const resolvedScript = resolveMusicApplicationReferences(script);
  const result = await $`osascript -l JavaScript -e ${resolvedScript}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const err = result.stderr.toString().trim();
    // Music.app not running — launch it silently and retry
    if (shouldRetryAfterMusicError(err)) {
      try {
        await ensureMusicRunning();
      } catch (launchErr) {
        if (isMusicScriptingUnavailableError(err)) {
          throw new ExternalServiceError(
            "Music.app could not be launched or controlled by this process.",
            musicScriptingUnavailableRecovery(),
            launchErr,
          );
        }
        throw launchErr;
      }
      const retry = await $`osascript -l JavaScript -e ${resolvedScript}`.quiet().nothrow();
      if (retry.exitCode !== 0) {
        const retryErr = retry.stderr.toString().trim();
        if (isMusicScriptingUnavailableError(retryErr)) {
          throw new ExternalServiceError(
            "Music.app could not be launched or controlled by this process.",
            musicScriptingUnavailableRecovery(),
          );
        }
        throw new ExternalServiceError(`JXA error: ${retryErr}`);
      }
      return retry.stdout.toString().trim();
    }
    throw new ExternalServiceError(`JXA error: ${err}`);
  }
  return result.stdout.toString().trim();
}

async function jxaJson<T>(script: string): Promise<T> {
  const wrapped = `
    const result = (() => { ${script} })();
    JSON.stringify(result);
  `;
  const raw = await jxa(wrapped);
  return JSON.parse(raw);
}

function parseTrack(raw: NativeTrackData): Track {
  return {
    ...buildIdentity({
      source: "native",
      persistentId: String(raw.persistentID ?? raw.id ?? ""),
    }),
    name: raw.name ?? "Unknown",
    artist: raw.artist ?? "Unknown",
    album: raw.album ?? "",
    duration: raw.duration ?? 0,
    trackNumber: raw.trackNumber,
    genre: raw.genre || undefined,
    year: raw.year || undefined,
  };
}

interface NativeTrackData {
  id?: number;
  persistentID?: string;
  name?: string;
  artist?: string;
  album?: string;
  duration?: number;
  trackNumber?: number;
  genre?: string;
  year?: number;
}

// Shared JXA expression that extracts raw track fields from a Music.app track
// reference named `t`. Every native track read returns this shape and is mapped
// to a Track through `parseTrack`, so IDs are constructed in exactly one place.
const JXA_TRACK_FIELDS = `{
  id: t.persistentID(),
  name: t.name(),
  artist: t.artist(),
  album: t.album(),
  duration: t.duration(),
  trackNumber: t.trackNumber(),
  genre: t.genre() || undefined,
  year: t.year() || undefined,
}`;

const NATIVE_CAPABILITIES: EngineCapabilities = {
  playback: true,
  queue: false,
  playlistMutation: true,
  devices: true,
  catalogSearch: false,
  libraryRead: true,
  shuffle: true,
  repeat: true,
};

function resolvePersistentId(id: string, entityLabel: string): string {
  const ref = parseEntityRef(id);
  if (ref) {
    if (ref.source !== "native" || ref.kind !== "persistent") {
      throw new UnsupportedOperationError(
        `${entityLabel} ${id} is not a native persistent ID`,
        `Use \`setlist --engine native ... --json\` and pass the ${entityLabel.toLowerCase()}'s \`persistentId\` field for native-only commands.`,
      );
    }
    return validateRawId(ref.value, entityLabel);
  }
  return validateRawId(id, entityLabel);
}

const VALID_DEVICE_KINDS = new Set<string>(["airplay", "bluetooth", "computer"]);

function normalizeDeviceKind(raw: string | undefined): DeviceKind {
  if (raw && VALID_DEVICE_KINDS.has(raw)) return raw as DeviceKind;
  return "unknown";
}

export function deriveAlbumsFromTracks(tracks: Track[], limit = 20): Album[] {
  const albums: Album[] = [];
  const seen = new Set<string>();
  for (const track of tracks) {
    if (!track.album) continue;
    const key = `${track.album}::${track.artist}`;
    if (seen.has(key)) continue;
    seen.add(key);
    albums.push({
      ...buildIdentity({ source: "native", derivedId: `album:${key}` }),
      name: track.album,
      artist: track.artist,
      trackCount: 0,
      year: track.year,
      genre: track.genre,
    });
  }
  return albums.slice(0, limit);
}

export function deriveArtistsFromTracks(tracks: Track[], limit = 20): Artist[] {
  const artists: Artist[] = [];
  const seen = new Set<string>();
  for (const track of tracks) {
    if (seen.has(track.artist)) continue;
    seen.add(track.artist);
    artists.push({
      ...buildIdentity({ source: "native", derivedId: `artist:${track.artist}` }),
      name: track.artist,
      genre: track.genre,
    });
  }
  return artists.slice(0, limit);
}

export class NativeEngine implements MusicEngine {
  name = "native";
  capabilities = NATIVE_CAPABILITIES;

  async play(query?: string): Promise<void> {
    if (!query) {
      await jxa(`
        const music = Application("Music");
        music.play();
      `);
      return;
    }

    // Search and play the first result
    await jxa(`
      const music = Application("Music");
      const tracks = music.search(music.libraryPlaylists[0], { for: ${JSON.stringify(query)} });
      if (tracks.length === 0) {
        // Try playing by name directly
        music.play();
      } else {
        music.play(tracks[0]);
      }
    `);
  }

  async pause(): Promise<void> {
    await jxa(`Application("Music").pause();`);
  }

  async resume(): Promise<void> {
    await jxa(`Application("Music").play();`);
  }

  async next(): Promise<void> {
    await jxa(`Application("Music").nextTrack();`);
  }

  async previous(): Promise<void> {
    await jxa(`Application("Music").previousTrack();`);
  }

  async seek(seconds: number): Promise<void> {
    await jxa(`Application("Music").playerPosition = ${seconds};`);
  }

  async setVolume(level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    await jxa(`Application("Music").soundVolume = ${clamped};`);
  }

  async getVolume(): Promise<number> {
    const raw = await jxa(`Application("Music").soundVolume();`);
    return parseInt(raw, 10);
  }

  async setShuffle(enabled: boolean): Promise<void> {
    await jxa(`Application("Music").shuffleEnabled = ${enabled};`);
  }

  async getShuffle(): Promise<boolean> {
    const raw = await jxa(`Application("Music").shuffleEnabled();`);
    return raw === "true";
  }

  async setRepeat(mode: "off" | "one" | "all"): Promise<void> {
    await jxa(`Application("Music").songRepeat = ${JSON.stringify(mode)};`);
  }

  async getRepeat(): Promise<"off" | "one" | "all"> {
    const raw = await jxa(`Application("Music").songRepeat();`);
    return raw === "one" || raw === "all" ? raw : "off";
  }

  async getStatus(): Promise<PlaybackState> {
    const raw = await jxaJson<{
      state: PlaybackState["state"];
      track: NativeTrackData | null;
      position: number;
      volume: number;
      shuffleEnabled: boolean;
      repeatMode: string;
    }>(`
      const music = Application("Music");
      const state = music.playerState();
      const stateMap = { "playing": "playing", "paused": "paused", "stopped": "stopped", "fast forwarding": "playing", "rewinding": "playing" };
      const mapped = stateMap[state] || "stopped";

      if (mapped === "stopped") {
        return { state: "stopped", track: null, position: 0, volume: music.soundVolume(), shuffleEnabled: music.shuffleEnabled(), repeatMode: "off" };
      }

      const t = music.currentTrack;
      return {
        state: mapped,
        track: ${JXA_TRACK_FIELDS},
        position: music.playerPosition(),
        volume: music.soundVolume(),
        shuffleEnabled: music.shuffleEnabled(),
        repeatMode: music.songRepeat(),
      };
    `);

    return {
      state: raw.state,
      track: raw.track ? parseTrack(raw.track) : null,
      position: raw.position,
      volume: raw.volume,
      shuffleEnabled: raw.shuffleEnabled,
      repeatMode: raw.repeatMode === "one" || raw.repeatMode === "all" ? raw.repeatMode : "off",
    };
  }

  async search(query: string, types: SearchType[], limit = 20): Promise<SearchResults> {
    const results: SearchResults = { tracks: [], albums: [], artists: [], playlists: [] };

    const needsTrackSearch = types.length === 0 || types.some((type) => type !== "playlist");
    const tracks = needsTrackSearch
      ? await jxaJson<NativeTrackData[]>(`
        const music = Application("Music");
        const found = music.search(music.libraryPlaylists[0], { for: ${JSON.stringify(query)} });
        const limit = ${limit};
        const tracks = [];
        for (let i = 0; i < Math.min(found.length, limit); i++) {
          const t = found[i];
          tracks.push(${JXA_TRACK_FIELDS});
        }
        return tracks;
      `)
      : [];
    const parsedTracks = tracks.map(parseTrack);

    if (types.includes("track") || types.length === 0) {
      results.tracks = parsedTracks;
    }

    if (types.includes("playlist")) {
      const playlists = await this.getPlaylists();
      const q = query.toLowerCase();
      results.playlists = playlists.filter((p) => p.name.toLowerCase().includes(q)).slice(0, limit);
    }

    // Albums and artists are derived from track search results (Music.app search only returns tracks)
    if (types.includes("album")) {
      results.albums = deriveAlbumsFromTracks(parsedTracks, limit);
    }

    if (types.includes("artist")) {
      results.artists = deriveArtistsFromTracks(parsedTracks, limit);
    }

    return results;
  }

  async addToQueue(trackId: string): Promise<void> {
    const persistentId = resolvePersistentId(trackId, "Track");
    throw new UnsupportedOperationError(
      `Queue management for track ${persistentId} is not implemented reliably for Music.app.`,
      "The previous implementation interrupted playback. Use `setlist play <query>` for now instead of `queue add`.",
    );
  }

  async getPlaylists(): Promise<Playlist[]> {
    const raw = await jxaJson<Array<{ persistentId: string; name: string; trackCount: number }>>(`
      const music = Application("Music");
      const playlists = music.playlists();
      const result = [];
      for (const p of playlists) {
        const kind = p.specialKind();
        // Skip internal playlists (Library, Music, etc.)
        if (kind === "none" || kind === "folder") {
          result.push({
            persistentId: p.persistentID(),
            name: p.name(),
            trackCount: p.tracks.length,
          });
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
    const info = await jxaJson<{ name: string; description: string; trackCount: number; hasArtwork: boolean }>(`
      const music = Application("Music");
      const playlists = music.playlists.whose({ persistentID: ${JSON.stringify(persistentId)} });
      if (playlists.length === 0) throw new Error("Playlist not found");
      const p = playlists[0];
      return {
        name: p.name(),
        description: p.description() || "",
        trackCount: p.tracks.length,
        hasArtwork: p.artworks.length > 0,
      };
    `);

    // Export artwork if it exists
    let artworkPath: string | undefined;
    if (info.hasArtwork) {
      try {
        const tmpPath = `/tmp/setlist-artwork-${persistentId}.png`;
        await jxa(`
          const music = Application("Music");
          const p = music.playlists.whose({ persistentID: ${JSON.stringify(persistentId)} })[0];
          const artwork = p.artworks[0];
          const rawData = artwork.rawData();
          const app = Application.currentApplication();
          app.includeStandardAdditions = true;
          const file = app.openForAccess(Path(${JSON.stringify(tmpPath)}), { writePermission: true });
          app.setEof(file, { to: 0 });
          app.write(rawData, { to: file });
          app.closeAccess(file);
        `);
        artworkPath = tmpPath;
      } catch {
        // Artwork export failed — not critical
      }
    }

    // Get tracks for analysis
    const tracks = await this.getPlaylistTracks(playlistId);

    // Compute top artists
    const artistCounts = new Map<string, number>();
    for (const t of tracks) {
      artistCounts.set(t.artist, (artistCounts.get(t.artist) || 0) + 1);
    }
    const topArtists = Array.from(artistCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, count]) => ({ name, count }));

    // Compute genres
    const genreCounts = new Map<string, number>();
    for (const t of tracks) {
      const g = t.genre || "Unknown";
      genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    }
    const genres = Array.from(genreCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    const totalDuration = tracks.reduce((sum, t) => sum + t.duration, 0);

    return {
      ...buildIdentity({ source: "native", persistentId }),
      name: info.name,
      description: info.description || undefined,
      trackCount: info.trackCount,
      totalDuration,
      artworkPath,
      tracks,
      topArtists,
      genres,
    };
  }

  async addToPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
    const persistentPlaylistId = resolvePersistentId(playlistId, "Playlist");
    for (const trackId of trackIds) {
      const persistentTrackId = resolvePersistentId(trackId, "Track");
      await jxa(`
        const music = Application("Music");
        const playlist = music.playlists.whose({ persistentID: ${JSON.stringify(persistentPlaylistId)} })[0];
        if (!playlist) throw new Error("Playlist not found: " + ${JSON.stringify(persistentPlaylistId)});
        const lib = music.libraryPlaylists[0];
        const tracks = lib.tracks.whose({ persistentID: ${JSON.stringify(persistentTrackId)} });
        if (tracks.length === 0) throw new Error("Track not found: " + ${JSON.stringify(persistentTrackId)});
        music.duplicate(tracks[0], { to: playlist });
      `);
    }
  }

  async removeFromPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
    const persistentPlaylistId = resolvePersistentId(playlistId, "Playlist");
    for (const trackId of trackIds) {
      const persistentTrackId = resolvePersistentId(trackId, "Track");
      await jxa(`
        const music = Application("Music");
        const playlist = music.playlists.whose({ persistentID: ${JSON.stringify(persistentPlaylistId)} })[0];
        if (!playlist) throw new Error("Playlist not found: " + ${JSON.stringify(persistentPlaylistId)});
        const tracks = playlist.tracks.whose({ persistentID: ${JSON.stringify(persistentTrackId)} });
        if (tracks.length === 0) throw new Error("Track not found in playlist: " + ${JSON.stringify(persistentTrackId)});
        tracks[0].delete();
      `);
    }
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    const persistentId = resolvePersistentId(playlistId, "Playlist");
    const raw = await jxaJson<NativeTrackData[]>(`
      const music = Application("Music");
      const playlists = music.playlists.whose({ persistentID: ${JSON.stringify(persistentId)} });
      if (playlists.length === 0) throw new Error("Playlist not found");
      const tracks = playlists[0].tracks();
      return tracks.map(t => (${JXA_TRACK_FIELDS}));
    `);
    return raw.map(parseTrack);
  }

  async getLibraryTracks(limit = 50, offset = 0): Promise<Track[]> {
    const raw = await jxaJson<NativeTrackData[]>(`
      const music = Application("Music");
      const allTracks = music.libraryPlaylists[0].tracks();
      const start = ${offset};
      const end = Math.min(start + ${limit}, allTracks.length);
      const result = [];
      for (let i = start; i < end; i++) {
        const t = allTracks[i];
        result.push(${JXA_TRACK_FIELDS});
      }
      return result;
    `);
    return raw.map(parseTrack);
  }

  async getLibraryAlbums(limit = 50, offset = 0): Promise<Album[]> {
    const raw = await jxaJson<
      Array<{ album: string; artist: string; trackCount: number; year?: number; genre?: string }>
    >(`
      const music = Application("Music");
      const allTracks = music.libraryPlaylists[0].tracks();
      const albumMap = {};

      for (let i = 0; i < allTracks.length; i++) {
        const t = allTracks[i];
        const album = t.album();
        const artist = t.artist();
        if (!album) continue;
        const key = album + "::" + artist;
        if (!albumMap[key]) {
          albumMap[key] = {
            album,
            artist,
            trackCount: 0,
            year: t.year() || undefined,
            genre: t.genre() || undefined,
          };
        }
        albumMap[key].trackCount += 1;
      }

      return Object.values(albumMap).slice(${offset}, ${offset} + ${limit});
    `);
    return raw.map((a) => ({
      ...buildIdentity({ source: "native", derivedId: `album:${a.album}::${a.artist}` }),
      name: a.album,
      artist: a.artist,
      trackCount: a.trackCount,
      year: a.year,
      genre: a.genre,
    }));
  }

  async getDevices(): Promise<Device[]> {
    const raw = await jxaJson<Array<{ id: string; name: string; kind?: string; active: boolean }>>(`
      const music = Application("Music");
      const devices = music.AirPlayDevices();
      return devices.map(d => ({
        id: d.persistentID ? d.persistentID() : d.name(),
        name: d.name(),
        kind: d.kind ? d.kind() : undefined,
        active: d.selected(),
      }));
    `);
    return raw.map((d) => ({ ...d, kind: normalizeDeviceKind(d.kind) }));
  }
}
