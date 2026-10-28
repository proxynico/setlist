// ── Core domain types ──

export type EntitySource = "native" | "api";

export interface EntityIdentity {
  id: string;
  source: EntitySource;
  persistentId?: string;
  libraryId?: string;
  catalogId?: string;
}

export interface Track extends EntityIdentity {
  name: string;
  artist: string;
  album: string;
  duration: number; // seconds
  trackNumber?: number;
  genre?: string;
  year?: number;
  artworkUrl?: string;
}

export interface Album extends EntityIdentity {
  name: string;
  artist: string;
  trackCount?: number; // absent when the source doesn't report it
  year?: number;
  genre?: string;
  artworkUrl?: string;
}

export interface Artist extends EntityIdentity {
  name: string;
  genre?: string;
  artworkUrl?: string;
}

export interface Playlist extends EntityIdentity {
  name: string;
  description?: string;
  trackCount?: number; // absent when the source doesn't report it
  artworkPath?: string; // local file path for native engine
  artworkUrl?: string; // URL for API engine
}

export interface CountedValue {
  name: string;
  count: number;
}

export interface PlaylistDetails extends Playlist {
  tracks: Track[];
  totalDuration: number; // seconds
  topArtists: CountedValue[];
  genres: CountedValue[];
}

export type RepeatMode = "off" | "one" | "all";

export interface PlaybackState {
  state: "playing" | "paused" | "stopped";
  track: Track | null;
  position: number; // seconds
  volume: number; // 0-100
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
}

export interface SearchResults {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
}

export type DeviceKind = "airplay" | "bluetooth" | "computer" | "unknown";

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  active: boolean;
}

// ── Engine interface ──

export interface MusicEngine {
  // Playback
  play(query?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(level: number): Promise<void>;
  getVolume(): Promise<number>;
  setShuffle(enabled: boolean): Promise<void>;
  getShuffle(): Promise<boolean>;
  setRepeat(mode: RepeatMode): Promise<void>;
  getRepeat(): Promise<RepeatMode>;
  getStatus(): Promise<PlaybackState>;

  // Search
  search(query: string, types: SearchType[], limit?: number): Promise<SearchResults>;

  // Library
  getPlaylists(): Promise<Playlist[]>;
  getPlaylistTracks(playlistId: string): Promise<Track[]>;
  getPlaylistInfo(playlistId: string): Promise<PlaylistDetails>;
  getLibraryTracks(limit?: number, offset?: number): Promise<Track[]>;
  getLibraryAlbums(limit?: number, offset?: number): Promise<Album[]>;

  // Playlist editing
  addToPlaylist(playlistId: string, trackIds: string[]): Promise<void>;
  removeFromPlaylist(playlistId: string, trackIds: string[]): Promise<void>;

  // Devices
  getDevices(): Promise<Device[]>;
}

export type SearchType = "track" | "album" | "artist" | "playlist";

export type OutputMode = "human" | "json" | "plain";

export const ENGINE_NAMES = ["native", "api", "auto"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export interface CliConfig {
  defaultEngine: EngineName;
  storefront: string; // two-letter country code, or "auto"
}
