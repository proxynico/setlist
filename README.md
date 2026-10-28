# Setlist

Apple Music from the command line.

Setlist remains maintained. Settled 24 October 2026 by Nico. Rejected: retiring
Setlist or treating it as archived.

Setlist controls Music.app on macOS, searches Apple Music, reads your
library, and helps audit and improve your playlists. It is built for both
humans and agents: every command has readable terminal output plus `--json` and
`--plain` modes for automation.

It is inspired by [Spogo](https://github.com/steipete/spogo), but for Apple
Music.

## What It Does

- Control playback: play, pause, skip, seek, volume, shuffle, repeat.
- Read playback status from Music.app.
- Search Apple Music catalog tracks, albums, artists, and playlists.
- Browse your Apple Music library and playlists.
- Audit your library for duplicates, orphan tracks, playlist shape, genres, and
  theme suggestions.
- Add or remove tracks from playlists through Music.app when using native IDs.
- Return stable JSON for scripts and AI agents.

The library-management commands are read-only. They do not delete tracks or
modify playlists.

## Install

```bash
git clone https://github.com/proxynico/setlist.git
cd setlist
bun install
bun link
```

After linking:

```bash
setlist --version
```

To build a single binary:

```bash
bun run build
```

The binary is written to `dist/setlist`.

## Quick Start

```bash
# Current playback state
setlist status

# Playback controls
setlist play
setlist pause
setlist next
setlist prev
setlist seek 60

# Volume and modes
setlist volume
setlist volume 60
setlist shuffle on
setlist repeat all

# Search
setlist search track "radiohead"
setlist search album "ok computer"
setlist search artist "faye wong"

# Library
setlist library tracks
setlist library albums
setlist library playlists
setlist library playlist <playlist-id>

# Library gardening
setlist library audit
setlist library duplicates
setlist library orphans
setlist library themes
```

## Output Modes

Every command supports three output modes:

```bash
setlist status          # human-readable
setlist status --json   # structured JSON
setlist status --plain  # tab-separated output
```

Use `--json` for agents and scripts. Use `--plain` for shell pipelines.

## Engines

Setlist has three engines.

| Engine | Use it for | Auth |
| --- | --- | --- |
| `native` | Music.app playback, local library, playlist edits, AirPlay devices | None |
| `api` | Apple Music catalog and cloud library reads | Apple Music web token |
| `auto` | Native for playback, API for catalog/library when authenticated | Optional |

`auto` is the default. It does not hide API failures. If API auth exists and an
API request fails, the real error is shown instead of silently falling back.
IDs from `--json` output always go back to the engine that produced them.

Choose an engine per command:

```bash
setlist --engine native status
setlist --engine api search track "new song"
setlist --engine auto library audit
```

Persist defaults:

```bash
setlist config engine auto
setlist config storefront auto
```

## Apple Music API Auth

Native playback works without auth. API search and cloud-library reads need the
`media-user-token` cookie from a browser session logged into
`music.apple.com`.

```bash
setlist auth import --browser safari
setlist auth import --browser chrome
setlist auth import --browser firefox
setlist auth token <media-user-token>
setlist auth status
```

Tokens are stored in macOS Keychain under the `setlist` service. They are
not written to config files.

## Library Gardening

Setlist treats your Apple Music library as a collection to maintain, not
just a list of tracks.

```bash
setlist library audit --json
```

The audit reports:

- total tracks, albums, artists, and playlists
- largest and smallest playlists
- top genres, artists, decades, and years
- tracks not represented in any normal playlist
- duplicate name/artist candidates
- exact catalog duplicate candidates
- orphan tracks that fit existing playlist themes
- playlist read errors, such as Apple special playlists that are listed but not
  readable through the API

Focused commands:

```bash
setlist library duplicates --json
setlist library orphans --json
setlist library themes --json
```

Useful limits while exploring:

```bash
setlist library audit --max-items 500
setlist library orphans --limit 50
setlist library themes --limit 10 --suggestions 50
```

These commands are safe review surfaces. They do not delete, remove, or add
anything.

## IDs

JSON output includes source-qualified IDs so commands know what kind of entity
they are handling.

| Format | Meaning |
| --- | --- |
| `native:persistent:ABC123` | Music.app persistent ID |
| `api:library:l.ABC123` | Apple Music library ID |
| `api:catalog:1234567` | Apple Music catalog ID |
| `native:derived:album:...` | Derived native search result |

Native-only mutation commands, such as playlist add/remove, require native
persistent IDs.

## Commands

```text
Playback:    play [query] | pause | resume | next | prev | seek <seconds> | status
Volume:      volume [0-100]
Modes:       shuffle [on|off] | repeat [off|one|all]
Search:      search track|album|artist|playlist|all <query> [-l limit]
Library:     library tracks|albums|playlists | library playlist <id>
Gardening:   library audit|duplicates|orphans|themes
Playlists:   playlist info <id> | playlist add <id> <trackIds...> | playlist remove <id> <trackIds...>
Queue:       queue add <trackId>   (fails explicitly; reliable queueing is not implemented)
Devices:     devices
Auth:        auth import|token|status|clear
Config:      config status | config engine [native|api|auto] | config storefront [code|auto]
```

Global flags:

```text
--json         JSON output
--plain        Tab-separated output
--no-color     Disable color output
--engine <e>   native | api | auto
-v, --verbose  Show the underlying cause/stack when a command fails
```

## Requirements

- macOS
- Music.app
- Bun
- Apple Music subscription for API catalog/library features

Music.app scripting requires macOS Automation permission for the app running
the command, usually Terminal, iTerm, Codex, or another shell host.

If Music.app works from a normal terminal but fails inside a Codex/cmux session,
run the whole command through the GUI user session:

```bash
launchctl asuser "$(id -u)" bun run src/index.ts status --json
```

Do not wrap only `osascript` inside `launchctl asuser`; launch the whole CLI
that way.

## Development

```bash
bun install
bun run src/index.ts status
bun run typecheck
bun test
bun run check
bun run build
```

Current test suite:

```bash
bun test  # 67 tests across 13 files
```

## Design Rules

- Preserve human, `--json`, and `--plain` output for every command.
- Keep IDs source-qualified.
- Store tokens only in Keychain.
- Use structured `MusicError` errors and output helpers.
- Keep library gardening read-only until an explicit apply/review flow exists.
- Queue management intentionally fails because reliable Music.app queueing is
  not implemented.

## License

MIT
