import type { CountedValue, Replay, Track } from "./types";

/** Artists by how many of the year's top songs are theirs; a tie goes to the artist with the higher-ranked song. */
export function artistsInTopSongs(songs: Track[]): CountedValue[] {
  const counts = new Map<string, number>();
  for (const song of songs) counts.set(song.artist, (counts.get(song.artist) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/** The Replay shape shared by `--json` output and the MCP server. */
export function replayReport(replay: Replay, limit: number) {
  return {
    ...replay.year,
    topSongs: replay.topSongs.slice(0, limit),
    artistsInTopSongs: artistsInTopSongs(replay.topSongs).slice(0, limit),
    years: replay.years,
  };
}
