import { describe, expect, test } from "bun:test";
import {
  createMusicApplicationSource,
  decodeArtworkData,
  deriveAlbumsFromTracks,
  deriveArtistsFromTracks,
  musicScriptingUnavailableRecovery,
  shouldRetryAfterMusicError,
} from "../src/engines/native";
import type { Track } from "../src/lib/types";

const tracks: Track[] = [
  {
    id: "native:persistent:1",
    source: "native",
    persistentId: "1",
    name: "Airbag",
    artist: "Radiohead",
    album: "OK Computer",
    duration: 276,
    genre: "Alternative",
    year: 1997,
  },
  {
    id: "native:persistent:2",
    source: "native",
    persistentId: "2",
    name: "Paranoid Android",
    artist: "Radiohead",
    album: "OK Computer",
    duration: 390,
    genre: "Alternative",
    year: 1997,
  },
  {
    id: "native:persistent:3",
    source: "native",
    persistentId: "3",
    name: "Everything in Its Right Place",
    artist: "Radiohead",
    album: "Kid A",
    duration: 251,
    genre: "Alternative",
    year: 2000,
  },
];

describe("native derived entities", () => {
  test("derives unique albums from track results", () => {
    const albums = deriveAlbumsFromTracks(tracks, 10);
    expect(albums).toHaveLength(2);
    expect(albums[0].id).toBe("native:derived:album:OK Computer::Radiohead");
  });

  test("derives unique artists from track results", () => {
    const artists = deriveArtistsFromTracks(tracks, 10);
    expect(artists).toHaveLength(1);
    expect(artists[0].id).toBe("native:derived:artist:Radiohead");
  });
});

describe("native artwork", () => {
  test("decodes the data literal Music.app returns for artwork", () => {
    expect(decodeArtworkData("'tdta'($FFD8FFE0$)")).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  });

  test("ignores tracks without artwork", () => {
    expect(decodeArtworkData("")).toBeUndefined();
  });
});

describe("native Music.app resolution", () => {
  test("uses the system Music.app path when it exists", () => {
    expect(createMusicApplicationSource("/System/Applications/Music.app")).toBe(
      'Application("/System/Applications/Music.app")',
    );
  });

  test("falls back to the application name when the system path is missing", () => {
    expect(createMusicApplicationSource("/definitely/not/Music.app")).toBe('Application("Music")');
  });

  test("retries when path-based Music.app access reports a missing parameter", () => {
    expect(shouldRetryAfterMusicError("execution error: Error: Error: Parameter is missing. (-1701)")).toBe(true);
  });

  test("retries when Music.app returns a scripting launch error", () => {
    expect(shouldRetryAfterMusicError("execution error: An error of type -10827 has occurred. (-10827)")).toBe(true);
  });

  test("explains the Codex sandbox recovery before Automation fallback", () => {
    const recovery = musicScriptingUnavailableRecovery();

    expect(recovery).toContain("outside the sandbox/escalated");
    expect(recovery).toContain("Automation permission");
  });
});
