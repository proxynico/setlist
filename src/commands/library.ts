import type { Command } from "commander";
import type { MusicEngine, OutputMode } from "../lib/types";
import { parseInteger } from "../lib/input";
import { type LibraryAudit, analyzeLibrarySnapshot, collectLibrarySnapshot } from "../lib/library-audit";
import {
  getOutputMode,
  outputTracks,
  outputAlbums,
  outputPlaylists,
  outputPlaylistDetails,
  outputAction,
  outputLibraryAudit,
  outputLibraryDuplicates,
  outputLibraryOrphans,
  outputLibraryThemes,
} from "../lib/output";

interface AuditOptions {
  maxItems: string;
  suggestions?: string;
  limit?: string;
}

interface AuditCommand {
  command: string;
  description: string;
  defaultLimit?: { value: string; description: string };
  defaultSuggestions?: string; // only commands that show theme suggestions take --suggestions
  output: (audit: LibraryAudit, mode: OutputMode, limit: number) => void;
}

const AUDIT_COMMANDS: AuditCommand[] = [
  {
    command: "audit",
    description: "Read-only library audit: counts, genres, playlists, duplicates, orphans, and theme suggestions",
    defaultSuggestions: "20",
    output: (audit, mode) => outputLibraryAudit(audit, mode),
  },
  {
    command: "duplicates",
    description: "Show read-only duplicate candidates",
    defaultLimit: { value: "25", description: "Max duplicate buckets per type" },
    output: outputLibraryDuplicates,
  },
  {
    command: "orphans",
    description: "Show tracks that are not represented in any normal playlist",
    defaultLimit: { value: "100", description: "Max tracks to output" },
    output: outputLibraryOrphans,
  },
  {
    command: "themes",
    description: "Suggest orphan tracks that fit existing playlist themes",
    defaultLimit: { value: "20", description: "Max suggestions per playlist to output" },
    defaultSuggestions: "50",
    output: outputLibraryThemes,
  },
];

export function registerLibraryCommands(program: Command, getEngine: () => MusicEngine) {
  const mode = () => getOutputMode(program.opts());

  const listTracks = async (id: string) => outputTracks(await getEngine().getPlaylistTracks(id), mode());
  const listPlaylists = async () => outputPlaylists(await getEngine().getPlaylists(), mode());

  const library = program.command("library").alias("lib").description("Browse your music library");

  library
    .command("tracks")
    .alias("songs")
    .description("List library tracks")
    .option("-l, --limit <n>", "Max results", "50")
    .option("-o, --offset <n>", "Offset", "0")
    .action(async (opts: { limit: string; offset: string }) => {
      const tracks = await getEngine().getLibraryTracks(
        parseInteger("limit", opts.limit, { min: 1 }),
        parseInteger("offset", opts.offset, { min: 0 }),
      );
      outputTracks(tracks, mode());
    });

  library
    .command("albums")
    .description("List library albums")
    .option("-l, --limit <n>", "Max results", "50")
    .option("-o, --offset <n>", "Offset", "0")
    .action(async (opts: { limit: string; offset: string }) => {
      const albums = await getEngine().getLibraryAlbums(
        parseInteger("limit", opts.limit, { min: 1 }),
        parseInteger("offset", opts.offset, { min: 0 }),
      );
      outputAlbums(albums, mode());
    });

  library.command("playlists").description("List your playlists").action(listPlaylists);
  library.command("playlist <id>").description("Show tracks in a playlist").action(listTracks);

  // ── Library gardening (read-only) ──

  for (const spec of AUDIT_COMMANDS) {
    const command = library.command(spec.command).description(spec.description);
    if (spec.defaultLimit) command.option("-l, --limit <n>", spec.defaultLimit.description, spec.defaultLimit.value);
    command.option("--max-items <n>", "Max library tracks/albums to scan", "20000");
    if (spec.defaultSuggestions) {
      command.option("--suggestions <n>", "Theme suggestions to compute per playlist", spec.defaultSuggestions);
    }
    command.action(async (opts: AuditOptions) => {
      const snapshot = await collectLibrarySnapshot(getEngine(), {
        maxItems: parseInteger("max items", opts.maxItems, { min: 1 }),
      });
      const audit = analyzeLibrarySnapshot(snapshot, {
        suggestionsPerTheme: parseInteger("suggestions", opts.suggestions ?? "20", { min: 1 }),
      });
      const limit = opts.limit === undefined ? Number.POSITIVE_INFINITY : parseInteger("limit", opts.limit, { min: 1 });
      spec.output(audit, mode(), limit);
    });
  }

  // ── Playlists ──

  const playlist = program.command("playlist").alias("pl").description("Playlist management");

  playlist
    .command("info <id>")
    .description("Show playlist details: description, artwork, top artists, genres")
    .action(async (id: string) => {
      outputPlaylistDetails(await getEngine().getPlaylistInfo(id), mode());
    });

  playlist
    .command("add <playlistId> <trackIds...>")
    .description("Add one or more tracks to a playlist by their persistent IDs")
    .action(async (playlistId: string, trackIds: string[]) => {
      await getEngine().addToPlaylist(playlistId, trackIds);
      outputAction(
        mode(),
        { action: "playlist_add", playlistId, trackIds, count: trackIds.length },
        `Added ${trackIds.length} track${trackIds.length === 1 ? "" : "s"} to playlist`,
      );
    });

  playlist
    .command("remove <playlistId> <trackIds...>")
    .alias("rm")
    .description("Remove one or more tracks from a playlist by their persistent IDs")
    .action(async (playlistId: string, trackIds: string[]) => {
      await getEngine().removeFromPlaylist(playlistId, trackIds);
      outputAction(
        mode(),
        { action: "playlist_remove", playlistId, trackIds, count: trackIds.length },
        `Removed ${trackIds.length} track${trackIds.length === 1 ? "" : "s"} from playlist`,
      );
    });

  playlist
    .command("tracks <id>")
    .description("List tracks in a playlist (alias for library playlist)")
    .action(listTracks);
  playlist.command("list").alias("ls").description("List all playlists").action(listPlaylists);
}
