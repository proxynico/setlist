import { describe, expect, mock, test } from "bun:test";
import { AutoEngine } from "../src/engines/auto";
import type { MusicEngine, PlaybackState, SearchResults } from "../src/lib/types";

function createStubEngine(overrides: Partial<MusicEngine> = {}): MusicEngine {
  return {
    play: async () => {},
    pause: async () => {},
    resume: async () => {},
    next: async () => {},
    previous: async () => {},
    seek: async () => {},
    setVolume: async () => {},
    getVolume: async () => 0,
    setShuffle: async () => {},
    getShuffle: async () => false,
    setRepeat: async () => {},
    getRepeat: async () => "off",
    getStatus: async (): Promise<PlaybackState> => ({
      state: "stopped",
      track: null,
      position: 0,
      volume: 0,
      shuffleEnabled: false,
      repeatMode: "off",
    }),
    search: async (): Promise<SearchResults> => ({ tracks: [], albums: [], artists: [], playlists: [] }),
    getPlaylists: async () => [],
    getPlaylistTracks: async () => [],
    getPlaylistInfo: async () => ({
      id: "native:derived:test",
      source: "native",
      name: "Test",
      trackCount: 0,
      totalDuration: 0,
      tracks: [],
      topArtists: [],
      genres: [],
    }),
    getLibraryTracks: async () => [],
    getLibraryAlbums: async () => [],
    addToPlaylist: async () => {},
    removeFromPlaylist: async () => {},
    getDevices: async () => [],
    ...overrides,
  };
}

describe("auto engine routing", () => {
  test("uses native search when no API token is configured", async () => {
    const nativeSearch = mock(async () => ({ tracks: [], albums: [], artists: [], playlists: [] }));
    const apiSearch = mock(async () => ({ tracks: [], albums: [], artists: [], playlists: [] }));
    const engine = new AutoEngine(
      createStubEngine({ search: nativeSearch }),
      createStubEngine({ search: apiSearch }),
      async () => undefined,
    );

    await engine.search("radiohead", ["track"], 5);

    expect(nativeSearch).toHaveBeenCalled();
    expect(apiSearch).not.toHaveBeenCalled();
  });

  test("uses API search when a token is configured", async () => {
    const nativeSearch = mock(async () => ({ tracks: [], albums: [], artists: [], playlists: [] }));
    const apiSearch = mock(async () => ({ tracks: [], albums: [], artists: [], playlists: [] }));
    const engine = new AutoEngine(
      createStubEngine({ search: nativeSearch }),
      createStubEngine({ search: apiSearch }),
      async () => "token",
    );

    await engine.search("radiohead", ["track"], 5);

    expect(apiSearch).toHaveBeenCalled();
    expect(nativeSearch).not.toHaveBeenCalled();
  });

  test("does not silently fall back when API search fails", async () => {
    const nativeSearch = mock(async () => ({ tracks: [], albums: [], artists: [], playlists: [] }));
    const apiSearch = mock(async () => {
      throw new Error("expired token");
    });
    const engine = new AutoEngine(
      createStubEngine({ search: nativeSearch }),
      createStubEngine({ search: apiSearch }),
      async () => "token",
    );

    await expect(engine.search("radiohead", ["track"], 5)).rejects.toThrow("expired token");
    expect(nativeSearch).not.toHaveBeenCalled();
  });

  test("routes source-qualified playlist IDs to the engine that issued them", async () => {
    const nativeTracks = mock(async () => []);
    const apiTracks = mock(async () => []);
    const engine = new AutoEngine(
      createStubEngine({ getPlaylistTracks: nativeTracks }),
      createStubEngine({ getPlaylistTracks: apiTracks }),
      async () => "token",
    );

    await engine.getPlaylistTracks("native:persistent:ABC123");
    await engine.getPlaylistTracks("api:library:p.123");

    expect(nativeTracks).toHaveBeenCalledWith("native:persistent:ABC123");
    expect(apiTracks).toHaveBeenCalledWith("api:library:p.123");
  });
});
