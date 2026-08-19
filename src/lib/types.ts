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
  trackCount: number;
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
  trackCount: number;
  duration?: number;
  artworkPath?: string; // local file path for native engine
  artworkUrl?: string; // URL for API engine
}

export interface PlaylistDetails extends Playlist {
  tracks: Track[];
  totalDuration: number; // seconds
  topArtists: { name: string; count: number }[];
  genres: { name: string; count: number }[];
}

export interface PlaybackState {
  state: "playing" | "paused" | "stopped";
  track: Track | null;
  position: number; // seconds
  volume: number; // 0-100
  shuffleEnabled: boolean;
  repeatMode: "off" | "one" | "all";
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

export interface EngineCapabilities {
  playback: boolean;
  queue: boolean;
  playlistMutation: boolean;
  devices: boolean;
  catalogSearch: boolean;
  libraryRead: boolean;
  shuffle: boolean;
  repeat: boolean;
}

// ── Engine interface ──

export interface MusicEngine {
  name: string;
  capabilities: EngineCapabilities;

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
  setRepeat(mode: "off" | "one" | "all"): Promise<void>;
  getRepeat(): Promise<"off" | "one" | "all">;
  getStatus(): Promise<PlaybackState>;

  // Search
  search(query: string, types: SearchType[], limit?: number): Promise<SearchResults>;

  // Queue
  addToQueue(trackId: string): Promise<void>;

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

export interface GlobalOptions {
  json: boolean;
  plain: boolean;
  noColor: boolean;
  verbose: boolean;
  engine: "native" | "api" | "auto";
}

export interface CliConfig {
  defaultEngine: "native" | "api" | "auto";
  browser?: string;
  storefront?: string;
}
