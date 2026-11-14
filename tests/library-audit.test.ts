import { describe, expect, test } from "bun:test";
import { analyzeLibrarySnapshot } from "../src/lib/library-audit";
import type { Playlist, Track } from "../src/lib/types";

function track(overrides: Partial<Track>): Track {
  return {
    id: overrides.id ?? `api:library:${overrides.libraryId ?? overrides.name}`,
    source: "api",
    libraryId: overrides.libraryId,
    catalogId: overrides.catalogId,
    name: overrides.name ?? "Untitled",
    artist: overrides.artist ?? "Unknown",
    album: overrides.album ?? "",
    duration: overrides.duration ?? 180,
    genre: overrides.genre,
    year: overrides.year,
  };
}

function playlist(name: string, id: string): Playlist {
  return {
    id,
    source: "api",
    libraryId: id.replace("api:library:", ""),
    name,
    trackCount: 0,
  };
}

describe("library audit analysis", () => {
  test("summarizes counts, duplicates, and orphan tracks", () => {
    const dialUp = playlist("dial up", "api:library:p.rock");
    const tracks = [
      track({
        name: "Everlong",
        artist: "Foo Fighters",
        album: "The Colour and the Shape",
        genre: "Rock",
        year: 1997,
        libraryId: "l.1",
        catalogId: "c.1",
      }),
      track({
        name: "Everlong",
        artist: "Foo Fighters",
        album: "Greatest Hits",
        genre: "Rock",
        year: 1997,
        libraryId: "l.2",
        catalogId: "c.1",
      }),
      track({
        name: "Nights",
        artist: "Frank Ocean",
        album: "Blonde",
        genre: "R&B/Soul",
        year: 2016,
        libraryId: "l.3",
        catalogId: "c.3",
      }),
    ];

    const audit = analyzeLibrarySnapshot({
      tracks,
      albums: [],
      playlists: [dialUp],
      playlistTracks: [{ playlist: dialUp, tracks: [tracks[0]] }],
    });

    expect(audit.counts.tracks).toBe(3);
    expect(audit.counts.tracksNotFoundInAnyPlaylist).toBe(1);
    expect(audit.counts.duplicateNameArtistBuckets).toBe(1);
    expect(audit.counts.exactCatalogDuplicateBuckets).toBe(1);
    expect(audit.duplicateCandidates[0].key).toBe("everlong::foo fighters");
    expect(audit.orphanTracks.map((t) => t.name)).toEqual(["Nights"]);
  });

  test("suggests orphan tracks for matching playlist themes", () => {
    const lateNight = playlist("2:47 am", "api:library:p.late");
    const tracks = [
      track({ name: "Japanese Denim", artist: "Daniel Caesar", genre: "R&B/Soul", year: 2016, libraryId: "l.1" }),
      track({ name: "Best Part", artist: "Daniel Caesar", genre: "R&B/Soul", year: 2017, libraryId: "l.2" }),
      track({ name: "Blue in Green", artist: "Miles Davis", genre: "Jazz", year: 1959, libraryId: "l.3" }),
    ];

    const audit = analyzeLibrarySnapshot(
      {
        tracks,
        albums: [],
        playlists: [lateNight],
        playlistTracks: [{ playlist: lateNight, tracks: [tracks[0]] }],
      },
      5,
    );

    expect(audit.themeSuggestions).toEqual([
      {
        playlistName: "2:47 am",
        playlistId: "api:library:p.late",
        candidates: [
          {
            track: expect.objectContaining({ name: "Best Part" }),
            score: expect.any(Number),
            reasons: expect.arrayContaining(["genre:R&B/Soul", "artist:Daniel Caesar", "decade:2010s"]),
          },
        ],
      },
    ]);
  });
});
