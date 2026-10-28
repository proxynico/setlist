import { readFileSync } from "node:fs";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json";
import { isMusicError } from "./lib/errors";
import {
  analyzeLibrarySnapshot,
  auditSummary,
  collectLibrarySnapshot,
  duplicatesReport,
  orphansReport,
  themesReport,
} from "./lib/library-audit";
import type { MusicEngine, SearchType } from "./lib/types";

/**
 * MCP server over the same engines as the CLI, so AI assistants can drive
 * Music.app and read Apple Music. Results are the CLI's `--json` shapes.
 */

const INSTRUCTIONS = `Setlist controls Apple Music on this Mac and reads the user's library.
IDs are source-qualified (native:persistent:…, api:library:…, api:catalog:…); pass them back unchanged.
Playlist edits need native:persistent IDs from Music.app, so read playlists and tracks with the native engine before editing.
Library reports only read; nothing here deletes tracks.`;

const READ_ONLY = { readOnlyHint: true };
const CONTROL = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { ...EDIT, destructiveHint: true };

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: true };

const json = (value: unknown): Content => ({ type: "text", text: JSON.stringify(value) });

function errorText(error: unknown): string {
  if (isMusicError(error)) return error.hint ? `${error.message}\n${error.hint}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

// Wraps a tool body: its content becomes the result, and anything it throws becomes an error result.
function tool<A>(body: (args: A) => Promise<Content[]>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return { content: await body(args) };
    } catch (error) {
      return { content: [{ type: "text", text: errorText(error) }], isError: true };
    }
  };
}

const SEARCH_TYPES: Record<string, SearchType[]> = {
  track: ["track"],
  album: ["album"],
  artist: ["artist"],
  playlist: ["playlist"],
  all: ["track", "album", "artist", "playlist"],
};

const limitSchema = (fallback: number) => z.number().int().min(1).max(500).default(fallback).describe("Max results");
const trackIds = z.array(z.string().min(1)).min(1).describe("native:persistent track IDs");

export function createMcpServer(getEngine: () => MusicEngine): {
  server: McpServer;
  tools: Record<string, RegisteredTool>;
} {
  const server = new McpServer({ name: pkg.name, version: pkg.version }, { instructions: INSTRUCTIONS });
  const tools: Record<string, RegisteredTool> = {};

  // ── Playback ──

  tools.status = server.registerTool(
    "status",
    {
      description: "What is playing: track, position, volume, shuffle and repeat. Can include the album art.",
      inputSchema: { artwork: z.boolean().default(false).describe("Also return the current track's album art") },
      annotations: READ_ONLY,
    },
    tool(async ({ artwork }) => {
      const { artworkPath, ...status } = await getEngine().getStatus({ artwork });
      const content = [json(status)];
      if (artworkPath) {
        content.push({ type: "image", data: readFileSync(artworkPath).toString("base64"), mimeType: "image/png" });
      }
      return content;
    }),
  );

  tools.play = server.registerTool(
    "play",
    {
      description: "Play the first library track matching a query, or resume playback when no query is given.",
      inputSchema: { query: z.string().min(1).optional().describe("Song, artist or album to find in the library") },
      annotations: CONTROL,
    },
    tool(async ({ query }) => {
      await getEngine().play(query);
      return [json({ action: "play", query: query ?? null })];
    }),
  );

  tools.playback = server.registerTool(
    "playback",
    {
      description: "Pause, resume, or skip to the next or previous track.",
      inputSchema: { action: z.enum(["pause", "resume", "next", "previous"]) },
      annotations: CONTROL,
    },
    tool(async ({ action }) => {
      await getEngine()[action]();
      return [json({ action })];
    }),
  );

  tools.seek = server.registerTool(
    "seek",
    {
      description: "Jump to a position in the current track.",
      inputSchema: { seconds: z.number().int().min(0) },
      annotations: CONTROL,
    },
    tool(async ({ seconds }) => {
      await getEngine().seek(seconds);
      return [json({ action: "seek", position: seconds })];
    }),
  );

  tools.set_volume = server.registerTool(
    "set_volume",
    {
      description: "Set Music.app's volume.",
      inputSchema: { level: z.number().int().min(0).max(100) },
      annotations: CONTROL,
    },
    tool(async ({ level }) => {
      await getEngine().setVolume(level);
      return [json({ action: "volume", volume: level })];
    }),
  );

  tools.set_shuffle = server.registerTool(
    "set_shuffle",
    {
      description: "Turn shuffle on or off.",
      inputSchema: { enabled: z.boolean() },
      annotations: CONTROL,
    },
    tool(async ({ enabled }) => {
      await getEngine().setShuffle(enabled);
      return [json({ shuffle: enabled })];
    }),
  );

  tools.set_repeat = server.registerTool(
    "set_repeat",
    {
      description: "Set repeat to off, one track, or all.",
      inputSchema: { mode: z.enum(["off", "one", "all"]) },
      annotations: CONTROL,
    },
    tool(async ({ mode }) => {
      await getEngine().setRepeat(mode);
      return [json({ repeat: mode })];
    }),
  );

  tools.devices = server.registerTool(
    "devices",
    {
      description: "List the speakers and AirPlay devices Music.app can play to.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    tool(async () => [json(await getEngine().getDevices())]),
  );

  // ── Search and library ──

  tools.search = server.registerTool(
    "search",
    {
      description:
        "Search the Apple Music catalog when signed in, otherwise the local library. With type all, the limit applies per type.",
      inputSchema: {
        query: z.string().min(1),
        type: z.enum(["track", "album", "artist", "playlist", "all"]).default("all"),
        limit: limitSchema(10),
      },
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    tool(async ({ query, type, limit }) => [json(await getEngine().search(query, SEARCH_TYPES[type], limit))]),
  );

  tools.library = server.registerTool(
    "library",
    {
      description: "List the user's library tracks, albums, or playlists.",
      inputSchema: {
        kind: z.enum(["tracks", "albums", "playlists"]),
        limit: limitSchema(50),
        offset: z.number().int().min(0).default(0).describe("Items to skip (tracks and albums)"),
      },
      annotations: READ_ONLY,
    },
    tool(async ({ kind, limit, offset }) => {
      const engine = getEngine();
      if (kind === "tracks") return [json(await engine.getLibraryTracks(limit, offset))];
      if (kind === "albums") return [json(await engine.getLibraryAlbums(limit, offset))];
      return [json(await engine.getPlaylists())];
    }),
  );

  tools.playlist = server.registerTool(
    "playlist",
    {
      description: "A playlist's tracks, length, top artists and genres.",
      inputSchema: { id: z.string().min(1).describe("Playlist ID from the library tool") },
      annotations: READ_ONLY,
    },
    tool(async ({ id }) => [json(await getEngine().getPlaylistInfo(id))]),
  );

  tools.library_report = server.registerTool(
    "library_report",
    {
      description: [
        "Read-only library gardening.",
        "summary: counts, top artists, genres and decades, and playlist sizes.",
        "duplicates: songs saved more than once.",
        "orphans: tracks in no playlist.",
        "themes: orphans that fit an existing playlist's genres, artists and era.",
        "Scans the whole library, so it can take a while on large libraries.",
      ].join(" "),
      inputSchema: {
        report: z.enum(["summary", "duplicates", "orphans", "themes"]),
        limit: limitSchema(25).describe("Max entries per list (duplicates, orphans, suggestions per playlist)"),
        max_items: z.number().int().min(1).default(20000).describe("Max library tracks and albums to scan"),
      },
      annotations: READ_ONLY,
    },
    tool(async ({ report, limit, max_items }) => {
      const snapshot = await collectLibrarySnapshot(getEngine(), { maxItems: max_items });
      const audit = analyzeLibrarySnapshot(snapshot, { suggestionsPerTheme: limit });
      if (report === "duplicates") return [json(duplicatesReport(audit, limit))];
      if (report === "orphans") return [json(orphansReport(audit, limit))];
      if (report === "themes") return [json(themesReport(audit, limit))];
      return [json(auditSummary(audit))];
    }),
  );

  // ── Playlist edits ──

  tools.playlist_add = server.registerTool(
    "playlist_add",
    {
      description: "Add tracks to a playlist in Music.app.",
      inputSchema: { playlist_id: z.string().min(1).describe("native:persistent playlist ID"), track_ids: trackIds },
      annotations: EDIT,
    },
    tool(async ({ playlist_id, track_ids }) => {
      await getEngine().addToPlaylist(playlist_id, track_ids);
      return [json({ action: "playlist_add", playlistId: playlist_id, trackIds: track_ids, count: track_ids.length })];
    }),
  );

  tools.playlist_remove = server.registerTool(
    "playlist_remove",
    {
      description: "Remove tracks from a playlist in Music.app. The tracks stay in the library.",
      inputSchema: { playlist_id: z.string().min(1).describe("native:persistent playlist ID"), track_ids: trackIds },
      annotations: DESTRUCTIVE,
    },
    tool(async ({ playlist_id, track_ids }) => {
      await getEngine().removeFromPlaylist(playlist_id, track_ids);
      return [
        json({ action: "playlist_remove", playlistId: playlist_id, trackIds: track_ids, count: track_ids.length }),
      ];
    }),
  );

  return { server, tools };
}
