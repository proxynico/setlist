import type { Command } from "commander";
import type { MusicEngine, OutputMode, SearchResults, SearchType } from "../lib/types";
import { parseInteger } from "../lib/input";
import {
  getOutputMode,
  outputTracks,
  outputAlbums,
  outputArtists,
  outputPlaylists,
  outputSearchResults,
} from "../lib/output";

interface SearchCommand {
  command: string;
  alias?: string;
  description: string;
  types: SearchType[];
  defaultLimit: string;
  output: (results: SearchResults, mode: OutputMode) => void;
}

const SEARCH_COMMANDS: SearchCommand[] = [
  {
    command: "track",
    alias: "song",
    description: "Search for tracks",
    types: ["track"],
    defaultLimit: "20",
    output: (results, mode) => outputTracks(results.tracks, mode),
  },
  {
    command: "album",
    description: "Search for albums",
    types: ["album"],
    defaultLimit: "20",
    output: (results, mode) => outputAlbums(results.albums, mode),
  },
  {
    command: "artist",
    description: "Search for artists",
    types: ["artist"],
    defaultLimit: "20",
    output: (results, mode) => outputArtists(results.artists, mode),
  },
  {
    command: "playlist",
    description: "Search for playlists",
    types: ["playlist"],
    defaultLimit: "20",
    output: (results, mode) => outputPlaylists(results.playlists, mode),
  },
  {
    command: "all",
    description: "Search across all types (limit applies per type)",
    types: ["track", "album", "artist", "playlist"],
    defaultLimit: "10",
    output: outputSearchResults,
  },
];

export function registerSearchCommands(program: Command, getEngine: () => MusicEngine) {
  const search = program
    .command("search")
    .description("Search the Apple Music catalog (falls back to your local library when not authenticated)");

  for (const spec of SEARCH_COMMANDS) {
    const command = search
      .command(`${spec.command} <query>`)
      .description(spec.description)
      .option("-l, --limit <n>", "Max results", spec.defaultLimit)
      .action(async (query: string, opts: { limit: string }) => {
        const limit = parseInteger("limit", opts.limit, { min: 1 });
        const results = await getEngine().search(query, spec.types, limit);
        spec.output(results, getOutputMode(program.opts()));
      });
    if (spec.alias) command.alias(spec.alias);
  }
}
