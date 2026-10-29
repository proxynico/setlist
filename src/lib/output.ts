import { readFileSync } from "node:fs";
import { duplicatesReport, type LibraryAudit, orphansReport, themesReport } from "./library-audit";
import { replayReport } from "./replay";
import { besideImage, type CellBox, type ImageProtocol, imageEscape } from "./terminal-image";
import type {
  OutputMode,
  Track,
  Album,
  Artist,
  Playlist,
  PlaylistDetails,
  PlaybackState,
  Replay,
  Device,
  SearchResults,
  CountedValue,
} from "./types";
import { isMusicError, ValidationError } from "./errors";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const WHITE = "\x1b[37m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

let colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
let verboseEnabled = false;

export function setColorEnabled(enabled: boolean) {
  colorEnabled = enabled;
}

export function setVerboseEnabled(enabled: boolean) {
  verboseEnabled = enabled;
}

function c(code: string, text: string): string {
  if (!colorEnabled) return text;
  return `${code}${text}${RESET}`;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function tsv(value: unknown): string {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

/** Print one tab-separated row; every cell is escaped. */
function row(...cells: unknown[]) {
  console.log(cells.map(tsv).join("\t"));
}

export function getOutputMode(opts: { json?: boolean; plain?: boolean }): OutputMode {
  if (opts.json && opts.plain) {
    throw new ValidationError("--json and --plain cannot be used together");
  }
  if (opts.json) return "json";
  if (opts.plain) return "plain";
  return "human";
}

export function outputJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

export function outputKeyValue(key: string, value: string) {
  console.log(`${c(DIM, `${key}:`)} ${value}`);
}

export function outputMessage(msg: string) {
  console.log(c(GREEN, msg));
}

/** Report a completed action: JSON gets `data`, humans get `message`, plain stays silent. */
export function outputAction(mode: OutputMode, data: Record<string, unknown>, message: string) {
  if (mode === "json") outputJson(data);
  else if (mode === "human") outputMessage(message);
}

/** Report a single value: `{ key: value }` as JSON, the bare value as plain, `label: value` for humans. */
export function outputValue(mode: OutputMode, key: string, value: string | number | boolean, label: string) {
  if (mode === "json") outputJson({ [key]: value });
  else if (mode === "plain") console.log(String(value));
  else outputKeyValue(label, String(value));
}

// ── Lists ──

interface ListFormat<T> {
  noun: string;
  plain: (item: T) => void;
  human: (item: T) => string;
}

function outputList<T>(items: T[], mode: OutputMode, format: ListFormat<T>) {
  if (mode === "json") return outputJson(items);
  if (mode === "plain") return items.forEach(format.plain);
  if (items.length === 0) return console.log(c(DIM, `No ${format.noun}s found`));
  console.log(c(DIM, plural(items.length, format.noun)));
  for (const [i, item] of items.entries()) {
    console.log(`${c(DIM, `${(i + 1).toString().padStart(3)}.`)} ${format.human(item)}`);
  }
}

const trackFormat: ListFormat<Track> = {
  noun: "track",
  plain: (t) => row("track", t.id, t.name, t.artist, t.album, formatDuration(t.duration), t.source),
  human: (t) =>
    `${c(BOLD + WHITE, t.name)} ${c(DIM, "--")} ${c(CYAN, t.artist)} ${c(DIM, "/")} ${c(DIM, t.album)} ${c(DIM, formatDuration(t.duration))}`,
};

const albumFormat: ListFormat<Album> = {
  noun: "album",
  plain: (a) => row("album", a.id, a.name, a.artist, a.trackCount, a.year, a.source),
  human: (a) =>
    [
      `${c(BOLD + WHITE, a.name)} ${c(DIM, "--")} ${c(CYAN, a.artist)}`,
      a.year ? c(DIM, `(${a.year})`) : "",
      a.trackCount !== undefined ? c(DIM, plural(a.trackCount, "track")) : "",
    ]
      .filter(Boolean)
      .join(" "),
};

const artistFormat: ListFormat<Artist> = {
  noun: "artist",
  plain: (a) => row("artist", a.id, a.name, a.genre, a.source),
  human: (a) => `${c(BOLD + WHITE, a.name)}${a.genre ? ` ${c(DIM, `(${a.genre})`)}` : ""}`,
};

const playlistFormat: ListFormat<Playlist> = {
  noun: "playlist",
  plain: (p) => row("playlist", p.id, p.name, p.trackCount, p.source),
  human: (p) =>
    `${c(BOLD + WHITE, p.name)}${p.trackCount !== undefined ? ` ${c(DIM, plural(p.trackCount, "track"))}` : ""}`,
};

const deviceFormat: ListFormat<Device> = {
  noun: "device",
  plain: (d) => row("device", d.id, d.name, d.kind, d.active),
  human: (d) => `${c(BOLD + WHITE, d.name)} ${c(DIM, d.kind)}${d.active ? c(GREEN, " (active)") : ""}`,
};

export function outputTracks(tracks: Track[], mode: OutputMode) {
  outputList(tracks, mode, trackFormat);
}

export function outputAlbums(albums: Album[], mode: OutputMode) {
  outputList(albums, mode, albumFormat);
}

export function outputArtists(artists: Artist[], mode: OutputMode) {
  outputList(artists, mode, artistFormat);
}

export function outputPlaylists(playlists: Playlist[], mode: OutputMode) {
  outputList(playlists, mode, playlistFormat);
}

export function outputDevices(devices: Device[], mode: OutputMode) {
  outputList(devices, mode, deviceFormat);
}

export function outputSearchResults(results: SearchResults, mode: OutputMode) {
  if (mode === "json") return outputJson(results);

  const sections = [
    { title: "Tracks", print: () => outputTracks(results.tracks, mode), count: results.tracks.length },
    { title: "Albums", print: () => outputAlbums(results.albums, mode), count: results.albums.length },
    { title: "Artists", print: () => outputArtists(results.artists, mode), count: results.artists.length },
    { title: "Playlists", print: () => outputPlaylists(results.playlists, mode), count: results.playlists.length },
  ].filter((section) => section.count > 0);

  if (sections.length === 0) {
    if (mode === "human") console.log(c(DIM, "No results found"));
    return;
  }
  for (const section of sections) {
    if (mode === "human") console.log(c(BOLD + CYAN, `\n${section.title}`));
    section.print();
  }
}

// ── Playback ──

const ARTWORK_BOX: CellBox = { columns: 12, rows: 6 };
const PROGRESS_WIDTH = 24;

/** Shorten `text` to `width` terminal cells, ending with an ellipsis. */
function fit(text: string, width?: number): string {
  if (width === undefined || Bun.stringWidth(text) <= width) return text;
  let out = "";
  for (const char of text) {
    if (Bun.stringWidth(`${out}${char}…`) > width) break;
    out += char;
  }
  return `${out}…`;
}

function statusLines(s: PlaybackState & { track: Track }, width?: number): string[] {
  const { track } = s;
  const album = [track.album, track.year].filter(Boolean).join(" · ");
  const filled = track.duration > 0 ? Math.round(Math.min(1, s.position / track.duration) * PROGRESS_WIDTH) : 0;
  const icon = s.state === "playing" ? c(GREEN, "▶") : c(YELLOW, "‖");
  const bar = `${c(WHITE, "━".repeat(filled))}${c(DIM, "─".repeat(PROGRESS_WIDTH - filled))}`;
  const modes = [
    `volume ${s.volume}`,
    s.shuffleEnabled ? "shuffle" : "",
    s.repeatMode !== "off" ? `repeat ${s.repeatMode}` : "",
  ].filter(Boolean);

  return [
    c(BOLD + WHITE, fit(track.name, width)),
    c(CYAN, fit(track.artist, width)),
    album ? c(DIM, fit(album, width)) : "",
    "",
    `${icon} ${c(DIM, formatDuration(s.position))} ${bar} ${c(DIM, formatDuration(track.duration))}`,
    c(DIM, modes.join(" · ")),
  ];
}

/** The current track's artwork as an inline image escape, when the terminal and track allow it. */
function artworkImage(s: PlaybackState, imageProtocol?: ImageProtocol): string | undefined {
  const columns = process.stdout.columns ?? 0;
  if (!imageProtocol || !s.artworkPath || columns < ARTWORK_BOX.columns + 40) return undefined;
  try {
    return imageEscape(imageProtocol, readFileSync(s.artworkPath), ARTWORK_BOX);
  } catch {
    return undefined; // Artwork is decoration; show the text alone.
  }
}

export function outputStatus(s: PlaybackState, mode: OutputMode, imageProtocol?: ImageProtocol) {
  if (mode === "json") return outputJson(s);
  if (mode === "plain") {
    const progress = s.track ? `${formatDuration(s.position)}/${formatDuration(s.track.duration)}` : "";
    return row(s.state, s.track?.name, s.track?.artist, progress, s.volume);
  }

  if (!s.track) {
    console.log(c(DIM, "Not playing"));
    return;
  }

  const playing = { ...s, track: s.track };
  const image = artworkImage(s, imageProtocol);
  const columns = process.stdout.columns;
  if (!image) {
    for (const line of statusLines(playing, columns && columns - 1)) console.log(line);
    return;
  }
  const lines = statusLines(playing, columns - ARTWORK_BOX.columns - 3);
  process.stdout.write(besideImage({ image, box: ARTWORK_BOX, lines }));
}

// ── Playlist details ──

function outputBars(title: string, items: CountedValue[]) {
  if (items.length === 0) return;
  console.log(c(BOLD + CYAN, `\n${title}`));
  for (const item of items) {
    const bar = "=".repeat(Math.min(item.count, 40));
    console.log(`  ${c(WHITE, item.name.padEnd(25))} ${c(DIM, bar)} ${c(DIM, String(item.count))}`);
  }
}

export function outputPlaylistDetails(details: PlaylistDetails, mode: OutputMode) {
  if (mode === "json") return outputJson(details);

  if (mode === "plain") {
    row("playlist", details.id, details.name, details.trackCount, details.totalDuration, details.description);
    if (details.artworkPath) row("artwork", details.artworkPath);
    if (details.artworkUrl) row("artwork_url", details.artworkUrl);
    for (const a of details.topArtists) row("artist", a.name, a.count);
    for (const g of details.genres) row("genre", g.name, g.count);
    return;
  }

  console.log(c(BOLD + WHITE, details.name));
  if (details.description) {
    console.log(c(DIM, details.description));
  }
  console.log();

  const hours = Math.floor(details.totalDuration / 3600);
  const mins = Math.floor((details.totalDuration % 3600) / 60);
  const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  console.log(`${c(CYAN, String(details.tracks.length))} tracks ${c(DIM, "--")} ${c(CYAN, durationStr)}`);

  const artwork = details.artworkPath ?? details.artworkUrl;
  if (artwork) {
    console.log(`${c(DIM, "Artwork:")} ${artwork}`);
  }

  outputBars("Top Artists", details.topArtists);
  outputBars("Genres", details.genres);
}

// ── Library gardening ──

export function outputLibraryAudit(audit: LibraryAudit, mode: OutputMode) {
  if (mode === "json") return outputJson(audit);

  const counts: Array<[plainKey: string, label: string, value: number]> = [
    ["tracks", "Tracks", audit.counts.tracks],
    ["albums", "Albums", audit.counts.albums],
    ["artists", "Artists", audit.counts.artists],
    ["playlists", "Playlists", audit.counts.playlists],
    ["orphans", "Tracks outside playlists", audit.counts.tracksNotFoundInAnyPlaylist],
    ["duplicates", "Duplicate name/artist buckets", audit.counts.duplicateNameArtistBuckets],
    ["exact_catalog_duplicates", "Exact catalog duplicate buckets", audit.counts.exactCatalogDuplicateBuckets],
  ];

  if (mode === "plain") {
    for (const [key, , value] of counts) row(key, value);
    return;
  }

  console.log(c(BOLD + WHITE, "Library Audit"));
  for (const [, label, value] of counts) outputKeyValue(label, String(value));

  if (audit.topGenres.length > 0) {
    console.log(c(BOLD + CYAN, "\nTop Genres"));
    for (const item of audit.topGenres.slice(0, 10)) console.log(`  ${item.name}: ${item.count}`);
  }
  if (audit.playlists.largest.length > 0) {
    console.log(c(BOLD + CYAN, "\nLargest Playlists"));
    for (const item of audit.playlists.largest.slice(0, 10)) {
      console.log(`  ${item.name}: ${item.fetchedTrackCount} tracks, ${item.durationHours}h`);
    }
  }
  if (audit.playlists.errors.length > 0) {
    console.log(c(BOLD + YELLOW, `\nUnreadable Playlists (${audit.playlists.errors.length})`));
    for (const item of audit.playlists.errors.slice(0, 10)) console.log(`  ${item.name}: ${c(DIM, item.error ?? "")}`);
  }
}

export function outputLibraryDuplicates(audit: LibraryAudit, mode: OutputMode, limit: number) {
  const payload = duplicatesReport(audit, limit);
  if (mode === "json") return outputJson(payload);
  if (mode === "plain") {
    for (const item of payload.duplicateCandidates) row("duplicate", item.key, item.count);
    for (const item of payload.exactCatalogDuplicates) row("exact_catalog_duplicate", item.catalogId, item.count);
    return;
  }

  console.log(c(BOLD + WHITE, "Duplicate Candidates"));
  if (payload.duplicateCandidates.length === 0 && payload.exactCatalogDuplicates.length === 0) {
    console.log(c(DIM, "No duplicate candidates found"));
    return;
  }
  for (const item of payload.duplicateCandidates) {
    console.log(`${c(CYAN, item.key)} ${c(DIM, `${item.count} tracks`)}`);
    for (const track of item.tracks.slice(0, 5)) console.log(`  ${track.name} ${c(DIM, "--")} ${track.album}`);
  }
  if (payload.exactCatalogDuplicates.length > 0) {
    console.log(c(BOLD + CYAN, "\nExact Catalog Duplicates"));
    for (const item of payload.exactCatalogDuplicates) console.log(`  ${item.catalogId}: ${item.count}`);
  }
}

export function outputLibraryOrphans(audit: LibraryAudit, mode: OutputMode, limit: number) {
  const report = orphansReport(audit, limit);
  if (mode === "json") return outputJson(report);
  if (mode === "human") console.log(c(BOLD + WHITE, `Tracks Outside Playlists (${report.count})`));
  outputTracks(report.tracks, mode);
}

export function outputLibraryThemes(audit: LibraryAudit, mode: OutputMode, limit: number) {
  const report = themesReport(audit, limit);
  const { suggestions } = report;

  if (mode === "json") return outputJson(report);
  if (mode === "plain") {
    for (const theme of suggestions) {
      for (const { score, track, reasons } of theme.candidates) {
        row("theme_candidate", theme.playlistName, score, track.id, track.name, track.artist, reasons.join(","));
      }
    }
    return;
  }

  console.log(c(BOLD + WHITE, "Theme Suggestions"));
  if (suggestions.length === 0) {
    console.log(c(DIM, "No theme suggestions found"));
    return;
  }
  for (const theme of suggestions) {
    console.log(c(BOLD + CYAN, `\n${theme.playlistName}`));
    for (const { track, reasons } of theme.candidates) {
      console.log(`  ${track.name} ${c(DIM, "--")} ${track.artist} ${c(DIM, `(${reasons.join(", ")})`)}`);
    }
  }
}

// ── Replay ──

const BAR_WIDTH = 24;

function scaledBars(items: Array<{ label: string; value: number; shown: string }>): string[] {
  const max = Math.max(1, ...items.map((item) => item.value));
  const labelWidth = Math.max(...items.map((item) => Bun.stringWidth(item.label)));
  return items.map(({ label, value, shown }) => {
    const bar = "━".repeat(Math.max(1, Math.round((value / max) * BAR_WIDTH)));
    const pad = " ".repeat(labelWidth - Bun.stringWidth(label));
    return `  ${c(WHITE, label)}${pad}  ${c(CYAN, bar)} ${c(DIM, shown)}`;
  });
}

const count = (value: number) => value.toLocaleString("en-US");

export function outputReplay(replay: Replay, mode: OutputMode, limit: number) {
  const report = replayReport(replay, limit);
  if (mode === "json") return outputJson(report);
  if (mode === "plain") {
    row("year", report.year, report.listenMinutes, report.songs, report.artists, report.genres, report.playlistId);
    for (const [i, t] of report.topSongs.entries()) row("song", i + 1, t.id, t.name, t.artist, t.album);
    for (const a of report.artistsInTopSongs) row("artist", a.name, a.count);
    for (const y of report.years) row("history", y.year, y.listenMinutes);
    return;
  }

  const final = report.listenMinutes !== undefined;
  console.log(c(BOLD + WHITE, `Replay ${report.year}${final ? "" : ", so far"}`));
  const totals = [
    report.listenMinutes !== undefined ? `${count(Math.round(report.listenMinutes / 60))} hours` : "",
    report.songs !== undefined ? `${count(report.songs)} songs` : "",
    report.artists !== undefined ? `${count(report.artists)} artists` : "",
    report.genres !== undefined ? `${count(report.genres)} genres` : "",
  ].filter(Boolean);
  if (totals.length > 0) console.log(c(DIM, totals.join(" · ")));

  if (report.topSongs.length > 0) {
    console.log(c(BOLD + CYAN, "\nTop Songs"));
    for (const [i, t] of report.topSongs.entries()) {
      console.log(
        `${c(DIM, `${(i + 1).toString().padStart(3)}.`)} ${c(BOLD + WHITE, t.name)} ${c(DIM, "--")} ${c(CYAN, t.artist)}`,
      );
    }
  }

  if (report.artistsInTopSongs.length > 0) {
    console.log(c(BOLD + CYAN, `\nMost Songs in Your Top ${replay.topSongs.length}`));
    const artists = report.artistsInTopSongs.map((a) => ({ label: a.name, value: a.count, shown: String(a.count) }));
    for (const line of scaledBars(artists)) console.log(line);
  }

  const history = report.years.filter((y) => y.listenMinutes !== undefined);
  if (history.length > 1) {
    console.log(c(BOLD + CYAN, "\nHours by Year"));
    const hours = history.map((y) => {
      const value = Math.round((y.listenMinutes ?? 0) / 60);
      return { label: String(y.year), value, shown: count(value) };
    });
    for (const line of scaledBars(hours)) console.log(line);
  }
}

// ── Errors ──

function formatCause(cause: unknown): string {
  if (cause instanceof Error) return cause.stack || `${cause.name}: ${cause.message}`;
  return String(cause);
}

export function outputErrorDetails(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(c(RED, `error: ${message}`));

  if (isMusicError(error)) {
    if (error.hint) console.error(c(DIM, error.hint));
    if (verboseEnabled && error.cause !== undefined) console.error(c(DIM, `cause: ${formatCause(error.cause)}`));
  } else if (verboseEnabled && error instanceof Error && error.stack) {
    console.error(c(DIM, error.stack));
  }
}
