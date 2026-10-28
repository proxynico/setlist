import { mapConcurrent } from "./concurrency";
import type { Album, CountedValue, MusicEngine, Playlist, PlaylistDetails, Track } from "./types";

export interface PlaylistTrackSnapshot {
  playlist: Playlist;
  tracks: Track[];
  error?: string;
}

export interface LibrarySnapshot {
  tracks: Track[];
  albums: Album[];
  playlists: Playlist[];
  playlistTracks: PlaylistTrackSnapshot[];
}

export interface CountSummary {
  tracks: number;
  albums: number;
  artists: number;
  albumArtists: number;
  playlists: number;
  playlistTracksFetched: number;
  tracksNotFoundInAnyPlaylist: number;
  duplicateNameArtistBuckets: number;
  exactCatalogDuplicateBuckets: number;
}

export interface DuplicateCandidate {
  key: string;
  count: number;
  tracks: Track[];
}

export interface ExactCatalogDuplicate {
  catalogId: string;
  count: number;
  tracks: Track[];
}

export interface PlaylistAuditSummary {
  name: string;
  id: string;
  reportedTrackCount?: number;
  fetchedTrackCount: number;
  durationHours: number;
  topGenres: CountedValue[];
  topArtists: CountedValue[];
  decades: CountedValue[];
  error?: string;
}

export interface ThemeSuggestion {
  playlistName: string;
  playlistId: string;
  candidates: Array<{
    track: Track;
    score: number;
    reasons: string[];
  }>;
}

export interface LibraryAudit {
  generatedAt: string;
  counts: CountSummary;
  topArtists: CountedValue[];
  topAlbumArtists: CountedValue[];
  topGenres: CountedValue[];
  topDecades: CountedValue[];
  topYears: CountedValue[];
  largestAlbums: CountedValue[];
  playlists: {
    largest: PlaylistAuditSummary[];
    smallest: PlaylistAuditSummary[];
    empty: PlaylistAuditSummary[];
    errors: PlaylistAuditSummary[];
  };
  duplicateCandidates: DuplicateCandidate[];
  exactCatalogDuplicates: ExactCatalogDuplicate[];
  orphanTracks: Track[];
  themeSuggestions: ThemeSuggestion[];
}

interface AnalyzeOptions {
  generatedAt?: string;
  suggestionsPerTheme?: number;
  topLimit?: number;
}

interface SnapshotOptions {
  maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 20_000;
const PLAYLIST_FETCH_CONCURRENCY = 4;

function countBy<T>(items: T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function top(map: Map<string, number>, limit: number): CountedValue[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)|\[[^\]]*]/g, "")
    .replace(
      /\b(remaster(?:ed)?|explicit|clean|deluxe|bonus track|single version|album version|radio edit|mono|stereo)\b/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function trackKey(track: Track): string {
  return `${normalizeText(track.name)}::${normalizeText(track.artist)}`;
}

function decade(year?: number): string {
  if (!year) return "Unknown";
  return `${Math.floor(year / 10) * 10}s`;
}

const genreOf = (track: Track) => track.genre || "Unknown";
const artistOf = (track: Track) => track.artist || "Unknown";
const decadeOf = (track: Track) => decade(track.year);

/** Duration and top artists/genres for a playlist's detail view. */
export function summarizePlaylistTracks(
  tracks: Track[],
): Pick<PlaylistDetails, "totalDuration" | "topArtists" | "genres"> {
  return {
    totalDuration: tracks.reduce((sum, track) => sum + track.duration, 0),
    topArtists: top(countBy(tracks, artistOf), 15),
    genres: top(countBy(tracks, genreOf), 10),
  };
}

interface PlaylistProfile extends PlaylistTrackSnapshot {
  genres: Map<string, number>;
  artists: Map<string, number>;
  decades: Map<string, number>;
}

function profilePlaylist(snapshot: PlaylistTrackSnapshot): PlaylistProfile {
  return {
    ...snapshot,
    genres: countBy(snapshot.tracks, genreOf),
    artists: countBy(snapshot.tracks, artistOf),
    decades: countBy(snapshot.tracks, decadeOf),
  };
}

function sortedPlaylistSummaries(profiles: PlaylistProfile[], topLimit: number): PlaylistAuditSummary[] {
  return profiles
    .map(({ playlist, tracks, error, genres, artists, decades }) => ({
      name: playlist.name,
      id: playlist.id,
      reportedTrackCount: playlist.trackCount,
      fetchedTrackCount: tracks.length,
      durationHours: Math.round(tracks.reduce((sum, track) => sum + (track.duration || 0), 0) / 360) / 10,
      topGenres: top(genres, topLimit),
      topArtists: top(artists, topLimit),
      decades: top(decades, topLimit),
      error,
    }))
    .sort((a, b) => b.fetchedTrackCount - a.fetchedTrackCount || a.name.localeCompare(b.name));
}

function findOrphanTracks(tracks: Track[], playlistTracks: PlaylistTrackSnapshot[]): Track[] {
  const libraryIds = new Set<string>();
  const catalogIds = new Set<string>();
  const keys = new Set<string>();

  for (const snapshot of playlistTracks) {
    for (const track of snapshot.tracks) {
      if (track.libraryId) libraryIds.add(track.libraryId);
      if (track.catalogId) catalogIds.add(track.catalogId);
      keys.add(trackKey(track));
    }
  }

  return tracks.filter(
    (track) =>
      !(track.libraryId && libraryIds.has(track.libraryId)) &&
      !(track.catalogId && catalogIds.has(track.catalogId)) &&
      !keys.has(trackKey(track)),
  );
}

/** Group tracks by key and keep the groups with more than one track, largest first. */
function duplicateBuckets(tracks: Track[], keyOf: (track: Track) => string | undefined): [string, Track[]][] {
  const buckets = new Map<string, Track[]>();
  for (const track of tracks) {
    const key = keyOf(track);
    if (!key) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(track);
    else buckets.set(key, [track]);
  }
  return Array.from(buckets.entries())
    .filter(([, items]) => items.length > 1)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function findDuplicateCandidates(tracks: Track[]): DuplicateCandidate[] {
  const keyOf = (track: Track) => {
    const key = trackKey(track);
    return key.startsWith("::") ? undefined : key;
  };
  return duplicateBuckets(tracks, keyOf).map(([key, items]) => ({ key, count: items.length, tracks: items }));
}

function findExactCatalogDuplicates(tracks: Track[]): ExactCatalogDuplicate[] {
  return duplicateBuckets(tracks, (track) => track.catalogId).map(([catalogId, items]) => ({
    catalogId,
    count: items.length,
    tracks: items,
  }));
}

function buildThemeSuggestions(
  profiles: PlaylistProfile[],
  orphanTracks: Track[],
  suggestionsPerTheme: number,
): ThemeSuggestion[] {
  const suggestions: ThemeSuggestion[] = [];

  for (const profile of profiles) {
    if (profile.error || profile.tracks.length === 0) continue;

    const topGenres = new Set(top(profile.genres, 8).map((item) => item.name));
    const topArtists = new Set(top(profile.artists, 12).map((item) => item.name));
    const topDecades = new Set(top(profile.decades, 4).map((item) => item.name));

    const candidates = orphanTracks
      .map((track) => {
        const reasons: string[] = [];
        let score = 0;
        if (track.genre && topGenres.has(track.genre)) {
          score += 5;
          reasons.push(`genre:${track.genre}`);
        }
        if (topArtists.has(track.artist)) {
          score += 4;
          reasons.push(`artist:${track.artist}`);
        }
        const trackDecade = decade(track.year);
        if (trackDecade !== "Unknown" && topDecades.has(trackDecade)) {
          score += 1;
          reasons.push(`decade:${trackDecade}`);
        }
        return { track, score, reasons };
      })
      .filter((candidate) => candidate.score >= 5)
      .sort((a, b) => b.score - a.score || a.track.name.localeCompare(b.track.name))
      .slice(0, suggestionsPerTheme);

    if (candidates.length > 0) {
      suggestions.push({
        playlistName: profile.playlist.name,
        playlistId: profile.playlist.id,
        candidates,
      });
    }
  }

  return suggestions.sort(
    (a, b) => b.candidates.length - a.candidates.length || a.playlistName.localeCompare(b.playlistName),
  );
}

export function analyzeLibrarySnapshot(snapshot: LibrarySnapshot, options: AnalyzeOptions = {}): LibraryAudit {
  const topLimit = options.topLimit ?? 25;
  const suggestionsPerTheme = options.suggestionsPerTheme ?? 20;
  const { tracks } = snapshot;
  const artistCounts = countBy(tracks, artistOf);
  const albumArtistCounts = countBy(snapshot.albums, (album) => album.artist || "Unknown");

  const duplicateCandidates = findDuplicateCandidates(tracks);
  const exactCatalogDuplicates = findExactCatalogDuplicates(tracks);
  const orphanTracks = findOrphanTracks(tracks, snapshot.playlistTracks);
  const profiles = snapshot.playlistTracks.map(profilePlaylist);
  const playlistSummaries = sortedPlaylistSummaries(profiles, 5);

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    counts: {
      tracks: tracks.length,
      albums: snapshot.albums.length,
      artists: artistCounts.size,
      albumArtists: albumArtistCounts.size,
      playlists: snapshot.playlists.length,
      playlistTracksFetched: snapshot.playlistTracks.reduce((sum, item) => sum + item.tracks.length, 0),
      tracksNotFoundInAnyPlaylist: orphanTracks.length,
      duplicateNameArtistBuckets: duplicateCandidates.length,
      exactCatalogDuplicateBuckets: exactCatalogDuplicates.length,
    },
    topArtists: top(artistCounts, topLimit),
    topAlbumArtists: top(albumArtistCounts, topLimit),
    topGenres: top(countBy(tracks, genreOf), topLimit),
    topDecades: top(countBy(tracks, decadeOf), topLimit),
    topYears: top(
      countBy(tracks, (track) => (track.year ? String(track.year) : "Unknown")),
      topLimit,
    ),
    largestAlbums: top(
      countBy(tracks, (track) => `${track.album || "Unknown"} - ${artistOf(track)}`),
      topLimit,
    ),
    playlists: {
      largest: playlistSummaries.slice(0, topLimit),
      smallest: playlistSummaries
        .slice()
        .sort((a, b) => a.fetchedTrackCount - b.fetchedTrackCount || a.name.localeCompare(b.name))
        .slice(0, topLimit),
      empty: playlistSummaries.filter((playlist) => playlist.fetchedTrackCount === 0),
      errors: playlistSummaries.filter((playlist) => playlist.error),
    },
    duplicateCandidates,
    exactCatalogDuplicates,
    orphanTracks,
    themeSuggestions: buildThemeSuggestions(profiles, orphanTracks, suggestionsPerTheme),
  };
}

export async function collectLibrarySnapshot(
  engine: MusicEngine,
  options: SnapshotOptions = {},
): Promise<LibrarySnapshot> {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

  // One call per collection: the API engine follows its own pagination links, and
  // the native engine reads the whole library in a few bulk Apple Events.
  const [tracks, albums, playlists] = await Promise.all([
    engine.getLibraryTracks(maxItems, 0),
    engine.getLibraryAlbums(maxItems, 0),
    engine.getPlaylists(),
  ]);

  const playlistTracks = await mapConcurrent(
    playlists,
    PLAYLIST_FETCH_CONCURRENCY,
    async (playlist): Promise<PlaylistTrackSnapshot> => {
      try {
        return { playlist, tracks: await engine.getPlaylistTracks(playlist.id) };
      } catch (error) {
        return { playlist, tracks: [], error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  return { tracks, albums, playlists, playlistTracks };
}
