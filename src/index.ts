#!/usr/bin/env bun

import { Command, CommanderError, Option } from "commander";
import pkg from "../package.json";
import { NativeEngine } from "./engines/native";
import { ApiEngine } from "./engines/api";
import { AutoEngine } from "./engines/auto";
import { registerPlaybackCommands } from "./commands/playback";
import { registerSearchCommands } from "./commands/search";
import { registerLibraryCommands } from "./commands/library";
import { registerAuthCommands } from "./commands/auth";
import { registerDeviceCommands } from "./commands/devices";
import { registerQueueCommands } from "./commands/queue";
import { registerConfigCommands } from "./commands/config";
import { registerMcpCommand } from "./commands/mcp";
import { loadConfig } from "./lib/config";
import { getOutputMode, outputErrorDetails, setColorEnabled, setVerboseEnabled } from "./lib/output";
import { type CliConfig, ENGINE_NAMES, type EngineName, type MusicEngine } from "./lib/types";

let config: CliConfig;

const program = new Command()
  .name("setlist")
  .description(pkg.description)
  .version(pkg.version)
  .option("--json", "Output as JSON")
  .option("--plain", "Output as tab-separated plain text")
  .option("--no-color", "Disable color output")
  .addOption(new Option("-e, --engine <engine>", "Engine").choices(ENGINE_NAMES))
  .option("-v, --verbose", "Show the underlying cause when a command fails")
  // Subcommands inherit this, so usage errors reach the catch below instead of exiting.
  .exitOverride()
  .hook("preAction", () => {
    const opts = program.opts();
    if (opts.color === false) setColorEnabled(false);
    if (opts.verbose) setVerboseEnabled(true);
    getOutputMode(opts); // reject --json with --plain before any command runs
  });

function createEngine(name: EngineName): MusicEngine {
  switch (name) {
    case "native":
      return new NativeEngine();
    case "api":
      return new ApiEngine();
    case "auto":
      return new AutoEngine();
  }
}

// Created on first use, so config and auth commands never touch Music.app or the API.
let engine: MusicEngine | undefined;
function getEngine(): MusicEngine {
  engine ??= createEngine(program.opts().engine ?? config.defaultEngine);
  return engine;
}

registerPlaybackCommands(program, getEngine);
registerSearchCommands(program, getEngine);
registerLibraryCommands(program, getEngine);
registerAuthCommands(program);
registerDeviceCommands(program, getEngine);
registerQueueCommands(program);
registerConfigCommands(program);
registerMcpCommand(program, getEngine);

try {
  config = await loadConfig();
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  // Commander has already printed its own help, version, and usage errors.
  if (err instanceof CommanderError) process.exit(err.exitCode);
  outputErrorDetails(err);
  process.exit(1);
}
