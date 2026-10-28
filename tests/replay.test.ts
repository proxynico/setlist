import { describe, expect, test } from "bun:test";
import { ApiEngine } from "../src/engines/api";
import { NativeEngine } from "../src/engines/native";
import { MusicError, UnsupportedOperationError } from "../src/lib/errors";
import { outputReplay, setColorEnabled } from "../src/lib/output";
import { artistsInTopSongs } from "../src/lib/replay";
import type { Replay, Track } from "../src/lib/types";

// Shaped like Apple's /me/music-summaries/search response; names and numbers are made up.
function summary(year: number, attributes: Record<string, unknown> = {}) {
  return {
    id: `year-${year}`,
    type: "music-summaries",
    attributes: { name: String(year), period: "year", year, ...attributes },
    relationships: {
      playlist: {
        data: [{ id: `pl.rp-${year}`, type: "playlists", href: `/v1/catalog/us/playlists/pl.rp-${year}` }],
      },
    },
  };
}

const summaries = {
  data: [
    summary(2024, { listenTimeInMinutes: 6000, uniqueSongCount: 700, uniqueArtistCount: 400, uniqueGenreCount: 60 }),
    summary(2026),
    summary(2025, { listenTimeInMinutes: 60000, uniqueSongCount: 3000, uniqueArtistCount: 1700 }),
  ],
  meta: { latestYear: 2026 },
};

function song(id: string, name: string, artistName: string) {
  return { id, type: "songs", attributes: { name, artistName, albumName: "Album", durationInMillis: 200000 } };
}

function replayEngine(requests: string[] = []) {
  return new ApiEngine({
    request: async <T>(path: string): Promise<T> => {
      requests.push(path);
      if (path === "/me/music-summaries/search") return summaries as T;
      if (path === "/catalog/us/playlists/pl.rp-2025/tracks") {
        return { data: [song("1", "Nights", "Frank Ocean"), song("2", "Latch", "Disclosure")] } as T;
      }
      throw new Error(`unexpected request: ${path}`);
    },
  });
}

describe("API Replay", () => {
  test("reads a year's totals and its top songs playlist", async () => {
    const requests: string[] = [];
    const replay = await replayEngine(requests).getReplay(2025);

    expect(replay.year).toEqual({
      year: 2025,
      listenMinutes: 60000,
      songs: 3000,
      artists: 1700,
      albums: undefined,
      genres: undefined,
      playlistId: "api:catalog:pl.rp-2025",
    });
    expect(replay.years.map((y) => y.year)).toEqual([2026, 2025, 2024]);
    expect(replay.topSongs.map((t) => [t.name, t.artist, t.id])).toEqual([
      ["Nights", "Frank Ocean", "api:catalog:1"],
      ["Latch", "Disclosure", "api:catalog:2"],
    ]);
    expect(requests).toEqual(["/me/music-summaries/search", "/catalog/us/playlists/pl.rp-2025/tracks"]);
  });

  test("defaults to the latest year", async () => {
    const engine = new ApiEngine({
      request: async <T>(path: string): Promise<T> => {
        if (path === "/me/music-summaries/search") return summaries as T;
        if (path === "/catalog/us/playlists/pl.rp-2026/tracks") return { data: [] } as T;
        throw new Error(`unexpected request: ${path}`);
      },
    });

    expect((await engine.getReplay()).year.year).toBe(2026);
  });

  test("names the years Apple has when the requested one is missing", async () => {
    const error = await replayEngine()
      .getReplay(2019)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MusicError);
    expect((error as MusicError).message).toBe("Apple Music has no Replay for 2019.");
    expect((error as MusicError).hint).toBe("Replay covers 2024 to 2026.");
  });

  test("the native engine explains that Replay needs API sign-in", async () => {
    await expect(new NativeEngine().getReplay()).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
});

describe("Replay report", () => {
  const track = (name: string, artist: string): Track => ({
    id: `api:catalog:${name}`,
    source: "api",
    catalogId: name,
    name,
    artist,
    album: "",
    duration: 200,
  });

  test("ranks artists by top songs, breaking ties by their best-ranked song", () => {
    const songs = [track("a", "B"), track("b", "A"), track("c", "A"), track("d", "B"), track("e", "C")];
    expect(artistsInTopSongs(songs)).toEqual([
      { name: "B", count: 2 },
      { name: "A", count: 2 },
      { name: "C", count: 1 },
    ]);
  });

  test("shows hours, top songs, artists and the yearly history", () => {
    const replay: Replay = {
      year: { year: 2025, listenMinutes: 60000, songs: 3000, artists: 1700, genres: 120 },
      years: [{ year: 2026 }, { year: 2025, listenMinutes: 60000 }, { year: 2024, listenMinutes: 6000 }],
      topSongs: [track("Nights", "Frank Ocean"), track("Latch", "Disclosure"), track("Ivy", "Frank Ocean")],
    };
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };
    setColorEnabled(false);

    try {
      outputReplay(replay, "human", 2);
    } finally {
      console.log = originalLog;
      setColorEnabled(true);
    }

    expect(lines).toEqual([
      "Replay 2025",
      "1,000 hours · 3,000 songs · 1,700 artists · 120 genres",
      "\nTop Songs",
      "  1. Nights -- Frank Ocean",
      "  2. Latch -- Disclosure",
      "\nMost Songs in Your Top Songs",
      `  Frank Ocean  ${"━".repeat(24)} 2`,
      `  Disclosure   ${"━".repeat(12)} 1`,
      "\nHours by Year",
      `  2025  ${"━".repeat(24)} 1,000`,
      `  2024  ${"━".repeat(2)} 100`,
    ]);
  });
});
