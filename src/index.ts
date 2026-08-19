#!/usr/bin/env bun

import { Command } from "commander";
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
import { loadConfig } from "./lib/config";
import { ValidationError } from "./lib/errors";
import { setColorEnabled, setVerboseEnabled, outputErrorDetails } from "./lib/output";
import type { CliConfig, MusicEngine } from "./lib/types";

const VERSION = "0.1.0";
let runtimeConfig: CliConfig = { defaultEngine: "auto", storefront: "auto" };

const program = new Command()
  .name("setlist")
  .description("Apple Music CLI for power users and AI agents")
  .version(VERSION)
  .option("--json", "Output as JSON")
  .option("--plain", "Output as tab-separated plain text")
  .option("--no-color", "Disable color output")
  .option("-e, --engine <engine>", "Engine: native, api, auto")
  .option("-v, --verbose", "Verbose output")
  .hook("preAction", () => {
    const opts = program.opts();
    if (opts.noColor || process.env.NO_COLOR || process.env.TERM === "dumb") {
      setColorEnabled(false);
    }
    if (opts.verbose) {
      setVerboseEnabled(true);
    }
    if (opts.json && opts.plain) {
      throw new ValidationError("--json and --plain cannot be used together");
    }
  });

function createEngine(): MusicEngine {
  const opts = program.opts();
  const engineName = opts.engine ?? runtimeConfig.defaultEngine ?? "auto";
  switch (engineName) {
    case "native":
      return new NativeEngine();
    case "api":
      return new ApiEngine();
    case "auto":
      return new AutoEngine();
    default:
      throw new ValidationError(`Unknown engine: ${engineName}. Use one of: native, api, auto`);
  }
}

// Lazy engine — created on first command that needs it
let engine: MusicEngine | null = null;
function getEngine(): MusicEngine {
  if (!engine) engine = createEngine();
  return engine;
}

// Register all command groups
registerPlaybackCommands(program, getEngine);
registerSearchCommands(program, getEngine);
registerLibraryCommands(program, getEngine);
registerAuthCommands(program);
registerDeviceCommands(program, getEngine);
registerQueueCommands(program, getEngine);
registerConfigCommands(program);

// Error handling
program.exitOverride();

async function main() {
  try {
    runtimeConfig = await loadConfig();
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "commander.helpDisplayed" || code === "commander.version") {
        process.exit(0);
      }
    }
    outputErrorDetails(err);
    process.exit(1);
  }
}

main();
