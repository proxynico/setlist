import type {
  MusicEngine,
  Track,
  Album,
  Playlist,
  PlaylistDetails,
  SearchResults,
  SearchType,
  RepeatMode,
} from "../lib/types";
import { NativeEngine } from "./native";
import { ApiEngine } from "./api";
import { parseEntityRef } from "../lib/entities";
import { getMediaUserToken } from "../lib/secrets";

/**
 * Auto engine — uses native for playback, API for catalog/library when available.
 * If no API auth is configured, everything routes through native.
 * Source-qualified IDs (`native:…`, `api:…`) always go to the engine that issued them.
 * If API auth exists but a request fails, the error propagates — no silent fallback.
 */
export class AutoEngine implements MusicEngine {
  private apiAvailable?: Promise<boolean>;

  constructor(
    private native: MusicEngine = new NativeEngine(),
    private api: MusicEngine = new ApiEngine(),
    private tokenLoader: () => Promise<string | undefined> = getMediaUserToken,
  ) {}

  /** The engine for library reads: the one an ID names, else API when authenticated. */
  private async reader(id?: string): Promise<MusicEngine> {
    const source = id ? parseEntityRef(id)?.source : undefined;
    if (source) return source === "api" ? this.api : this.native;
    this.apiAvailable ??= this.tokenLoader().then(Boolean);
    return (await this.apiAvailable) ? this.api : this.native;
  }

  // Playback always goes through native
  play(query?: string) {
    return this.native.play(query);
  }
  pause() {
    return this.native.pause();
  }
  resume() {
    return this.native.resume();
  }
  next() {
    return this.native.next();
  }
  previous() {
    return this.native.previous();
  }
  seek(seconds: number) {
    return this.native.seek(seconds);
  }
  setVolume(level: number) {
    return this.native.setVolume(level);
  }
  getVolume() {
    return this.native.getVolume();
  }
  setShuffle(enabled: boolean) {
    return this.native.setShuffle(enabled);
  }
  getShuffle() {
    return this.native.getShuffle();
  }
  setRepeat(mode: RepeatMode) {
    return this.native.setRepeat(mode);
  }
  getRepeat() {
    return this.native.getRepeat();
  }
  getStatus() {
    return this.native.getStatus();
  }
  getDevices() {
    return this.native.getDevices();
  }
  addToPlaylist(playlistId: string, trackIds: string[]) {
    return this.native.addToPlaylist(playlistId, trackIds);
  }
  removeFromPlaylist(playlistId: string, trackIds: string[]) {
    return this.native.removeFromPlaylist(playlistId, trackIds);
  }

  // Search: API catalog search when authenticated, otherwise native library search.
  async search(query: string, types: SearchType[], limit?: number): Promise<SearchResults> {
    return (await this.reader()).search(query, types, limit);
  }

  // Library: prefer API when authenticated for richer metadata; otherwise use native.
  async getPlaylists(): Promise<Playlist[]> {
    return (await this.reader()).getPlaylists();
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    return (await this.reader(playlistId)).getPlaylistTracks(playlistId);
  }

  async getPlaylistInfo(playlistId: string): Promise<PlaylistDetails> {
    return (await this.reader(playlistId)).getPlaylistInfo(playlistId);
  }

  async getLibraryTracks(limit?: number, offset?: number): Promise<Track[]> {
    return (await this.reader()).getLibraryTracks(limit, offset);
  }

  async getLibraryAlbums(limit?: number, offset?: number): Promise<Album[]> {
    return (await this.reader()).getLibraryAlbums(limit, offset);
  }
}
