import { describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ValidationError } from "../src/lib/errors";
import type { EngineName, MusicEngine, PlaybackState } from "../src/lib/types";
import { createMcpServer } from "../src/mcp";
import { createStubEngine } from "./stub-engine";

async function connect(engine: MusicEngine, engines: Partial<Record<EngineName, MusicEngine>> = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer((name) => (name && engines[name]) || engine).server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: CallResult): string {
  const [first] = result.content as Array<{ type: string; text?: string }>;
  return first.text ?? "";
}

const playing: PlaybackState = {
  state: "playing",
  track: {
    id: "native:persistent:ABC123",
    source: "native",
    persistentId: "ABC123",
    name: "White Ferrari",
    artist: "Frank Ocean",
    album: "Blonde",
    duration: 248,
  },
  position: 30,
  volume: 60,
  shuffleEnabled: false,
  repeatMode: "off",
};

describe("MCP server", () => {
  test("marks reads as read-only and playlist removal as destructive", async () => {
    const client = await connect(createStubEngine());
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(Object.keys(byName).sort()).toEqual([
      "devices",
      "library",
      "library_report",
      "play",
      "playback",
      "playlist",
      "playlist_add",
      "playlist_remove",
      "search",
      "seek",
      "set_repeat",
      "set_shuffle",
      "set_volume",
      "status",
    ]);
    expect(byName.search.annotations?.readOnlyHint).toBe(true);
    expect(byName.library_report.annotations?.readOnlyHint).toBe(true);
    expect(byName.playlist_remove.annotations?.destructiveHint).toBe(true);
    // Skipping twice skips two tracks; setting the volume twice changes nothing more.
    expect(byName.playback.annotations?.idempotentHint).toBe(false);
    expect(byName.set_volume.annotations?.idempotentHint).toBe(true);
  });

  test("reads from the engine a tool asks for, so edits can get native IDs", async () => {
    const defaultPlaylists = mock(async () => []);
    const nativePlaylists = mock(async () => []);
    const client = await connect(createStubEngine({ getPlaylists: defaultPlaylists }), {
      native: createStubEngine({ getPlaylists: nativePlaylists }),
    });

    await client.callTool({ name: "library", arguments: { kind: "playlists" } });
    await client.callTool({ name: "library", arguments: { kind: "playlists", engine: "native" } });

    expect(defaultPlaylists).toHaveBeenCalledTimes(1);
    expect(nativePlaylists).toHaveBeenCalledTimes(1);
  });

  test("returns status as JSON, with album art only when asked", async () => {
    const artworkPath = join(tmpdir(), "setlist-mcp-test.png");
    await Bun.write(artworkPath, new Uint8Array([137, 80, 78, 71]));
    const getStatus = mock(async ({ artwork = false } = {}) => ({ ...playing, ...(artwork ? { artworkPath } : {}) }));
    const client = await connect(createStubEngine({ getStatus }));

    const plain = await client.callTool({ name: "status", arguments: {} });
    expect(JSON.parse(textOf(plain))).toEqual(playing);
    expect(plain.content).toHaveLength(1);

    const withArt = await client.callTool({ name: "status", arguments: { artwork: true } });
    expect(JSON.parse(textOf(withArt))).toEqual(playing);
    expect((withArt.content as unknown[])[1]).toEqual({ type: "image", data: "iVBORw==", mimeType: "image/png" });
  });

  test("searches the requested types with the requested limit", async () => {
    const search = mock<MusicEngine["search"]>(async () => ({ tracks: [], albums: [], artists: [], playlists: [] }));
    const client = await connect(createStubEngine({ search }));

    await client.callTool({ name: "search", arguments: { query: "frank ocean", type: "track", limit: 3 } });
    await client.callTool({ name: "search", arguments: { query: "blonde" } });

    expect(search.mock.calls).toEqual([
      ["frank ocean", ["track"], 3],
      ["blonde", ["track", "album", "artist", "playlist"], 10],
    ]);
  });

  test("routes playback actions to the engine", async () => {
    const next = mock(async () => {});
    const client = await connect(createStubEngine({ next }));

    const result = await client.callTool({ name: "playback", arguments: { action: "next" } });

    expect(next).toHaveBeenCalledTimes(1);
    expect(JSON.parse(textOf(result))).toEqual({ action: "next" });
  });

  test("reports engine errors with their hint", async () => {
    const addToPlaylist = mock(async () => {
      throw new ValidationError("Playlist ID must be native", "Use a native:persistent ID.");
    });
    const client = await connect(createStubEngine({ addToPlaylist }));

    const result = await client.callTool({
      name: "playlist_add",
      arguments: { playlist_id: "api:library:p.1", track_ids: ["native:persistent:1"] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Playlist ID must be native\nUse a native:persistent ID.");
  });
});
