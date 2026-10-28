# Setlist

Apple Music CLI for power users and AI agents.

Repo: `https://github.com/proxynico/setlist`

Setlist remains maintained. Settled 24 October 2026 by Nico. Rejected: retiring
Setlist or treating it as archived.

## What This App Is

Setlist is a Bun/TypeScript command-line tool for Apple Music. It has two
jobs:

1. Control and inspect Music.app locally on macOS.
2. Read/search Apple Music catalog and cloud-library data with agent-friendly
   JSON output.

It also includes read-only library gardening commands for auditing duplicates,
orphan tracks, playlist shape, and theme suggestions.

## Stack

- Runtime: Bun
- Language: TypeScript, strict mode
- CLI framework: Commander.js
- MCP: `@modelcontextprotocol/sdk` with zod input schemas
- Lint/format: Biome (`bun run check` runs it first)
- Native control: Music.app JXA through `osascript`
- API reads: `amp-api.music.apple.com`
- Secrets: macOS Keychain through `security`

## Engines

All engines implement `MusicEngine` in `src/lib/types.ts`.

| Engine | Purpose | Auth |
| --- | --- | --- |
| `native` | Music.app playback, local library, playlist edits, devices | None |
| `api` | Apple Music catalog and cloud-library reads | `media-user-token` in Keychain |
| `auto` | Native for playback, API for catalog/library when authenticated | Optional |

Important: `auto` must not silently hide authenticated API failures. If auth is
configured and the API call fails, surface the real error.

## Project Map

```text
src/
  index.ts              Commander entrypoint, engine factory, config loading
  commands/
    playback.ts         play, pause, resume, next, prev, seek, status, volume, shuffle, repeat
    search.ts           search track|album|artist|playlist|all
    library.ts          tracks, albums, playlists, audit, duplicates, orphans, themes
    auth.ts             auth import|token|status|clear
    config.ts           config status|engine|storefront
    mcp.ts              mcp: stdio MCP server command
    replay.ts           replay [year]: Apple Music Replay
    devices.ts          AirPlay device listing
    queue.ts            queue add, explicit unsupported operation
  engines/
    native.ts           Music.app JXA engine
    api.ts              Apple Music API engine
    auto.ts             Native/API router
  mcp.ts                MCP tools over the engines; results reuse the --json shapes
  lib/
    types.ts            Domain types and MusicEngine interface
    entities.ts         Source-qualified entity IDs and validation
    errors.ts           MusicError hierarchy
    input.ts            Input parsing
    output.ts           Human, JSON, and plain output helpers
    terminal-image.ts   Inline album art for Kitty- and iTerm2-protocol terminals
    library-audit.ts    Read-only library gardening analysis
    replay.ts           Replay report shape and artists-in-top-songs ranking
    config.ts           Config file
    concurrency.ts      Bounded parallel map
    cookies.ts          Browser cookie extraction
    safari-cookies.ts   Safari binarycookies parser
    secrets.ts          Keychain storage (user token, cached developer token)
tests/
  api-parsing.test.ts   API identity, validation, storefront, pagination
  library-audit.test.ts Library audit analysis
  *.test.ts             Engine, output, config, validation, CLI contracts
```

## Command Surface

```text
Playback:    play [query] | pause | resume | next | prev | seek <seconds> | status
Volume:      volume [0-100]
Modes:       shuffle [on|off] | repeat [off|one|all]
Search:      search track|album|artist|playlist|all <query> [-l limit]
Library:     library tracks|albums|playlists | library playlist <id>
Gardening:   library audit|duplicates|orphans|themes
Replay:      replay [year] [-l limit]   (API only)
Playlists:   playlist info <id> | playlist add <id> <trackIds...> | playlist remove <id> <trackIds...>
Queue:       queue add <trackId> (explicitly unsupported)
Devices:     devices
MCP:         mcp
Auth:        auth import|token|status|clear
Config:      config status | config engine [native|api|auto] | config storefront [code|auto]
```

## Key Rules

- Preserve human, `--json`, and `--plain` output for every command.
- Give each command that agents need a matching MCP tool in `src/mcp.ts`, returning
  the same shape as its `--json` output.
- Use output helpers from `src/lib/output.ts`; do not raw-print errors.
- Use `MusicError` subclasses for expected failures.
- Keep IDs source-qualified:
  - `native:persistent:*`
  - `api:library:*`
  - `api:catalog:*`
- Store Apple Music tokens only in Keychain.
- Never write auth tokens to config, docs, logs, or tests.
- Native JXA input must be validated or inserted with `JSON.stringify()`.
- Native reads use bulk getters (`tracks.name()`) or one `properties()` call per
  track. Each Apple Event costs about 25ms, so per-field reads turn a library
  scan into minutes.
- Library gardening commands are read-only until an explicit review/apply flow
  exists.
- Queue management stays explicitly unsupported unless a reliable Music.app
  queue path is proven.

## Local Commands

```bash
bun install
bun run src/index.ts status --json
bun run src/index.ts search track "radiohead" --json
bun run src/index.ts --engine api library audit --max-items 100 --json
bun run typecheck
bun run lint     # biome lint + format check
bun run format   # biome lint + format, write fixes
bun test
bun run check    # biome + typecheck + test
bun run build
```

Current suite:

```bash
bun test  # 88 tests across 16 files
```

## macOS Notes

Music.app scripting needs a normal GUI session plus Automation permission for
the calling app.

If native commands fail inside Codex/cmux but work in Terminal, launch the whole
CLI through the GUI user session:

```bash
launchctl asuser "$(id -u)" bun run src/index.ts status --json
```

Do not wrap only `osascript`; run the full CLI command that way.

## Adding Work

For a command:

1. Add command wiring in `src/commands/`.
2. Keep data shaping in `src/lib/` when it is reusable or testable.
3. Accept `program: Command` and `getEngine: () => MusicEngine`.
4. Support human, JSON, and plain output.
5. Add focused tests.
6. Run `bun run check`.

For engine behavior:

1. Update `MusicEngine` in `src/lib/types.ts`.
2. Implement native, API, and auto behavior.
3. Throw `UnsupportedOperationError` where an engine cannot support the method.
4. Add tests before relying on the behavior.
