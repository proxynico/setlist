import { Argument, type Command } from "commander";
import type { MusicEngine, RepeatMode } from "../lib/types";
import { parseInteger } from "../lib/input";
import { formatDuration, getOutputMode, outputAction, outputStatus, outputValue } from "../lib/output";
import { detectImageProtocol } from "../lib/terminal-image";

export function registerPlaybackCommands(program: Command, getEngine: () => MusicEngine) {
  const mode = () => getOutputMode(program.opts());

  program
    .command("play [query]")
    .description("Play the first library track matching a query, or resume playback")
    .action(async (query?: string) => {
      await getEngine().play(query);
      outputAction(mode(), { action: "play", query: query || null }, query ? `Playing: ${query}` : "Resumed playback");
    });

  program
    .command("pause")
    .description("Pause playback")
    .action(async () => {
      await getEngine().pause();
      outputAction(mode(), { action: "pause" }, "Paused");
    });

  program
    .command("resume")
    .description("Resume playback")
    .action(async () => {
      await getEngine().resume();
      outputAction(mode(), { action: "resume" }, "Resumed");
    });

  program
    .command("next")
    .description("Skip to next track")
    .action(async () => {
      await getEngine().next();
      outputAction(mode(), { action: "next" }, "Skipped to next track");
    });

  program
    .command("prev")
    .description("Go to previous track")
    .action(async () => {
      await getEngine().previous();
      outputAction(mode(), { action: "previous" }, "Previous track");
    });

  program
    .command("seek <seconds>")
    .description("Seek to position in seconds")
    .action(async (seconds: string) => {
      const position = parseInteger("seek position", seconds, { min: 0 });
      await getEngine().seek(position);
      outputAction(mode(), { action: "seek", position }, `Seeked to ${formatDuration(position)}`);
    });

  program
    .command("status")
    .description("Show current playback status")
    .action(async () => {
      const outputMode = mode();
      const imageProtocol = outputMode === "human" ? detectImageProtocol() : undefined;
      const status = await getEngine().getStatus({ artwork: imageProtocol !== undefined });
      outputStatus(status, outputMode, imageProtocol);
    });

  program
    .command("volume [level]")
    .description("Get or set volume (0-100)")
    .action(async (level?: string) => {
      if (level === undefined) {
        outputValue(mode(), "volume", await getEngine().getVolume(), "Volume");
        return;
      }
      const volume = parseInteger("volume", level, { min: 0, max: 100 });
      await getEngine().setVolume(volume);
      outputAction(mode(), { action: "volume", volume }, `Volume set to ${volume}`);
    });

  program
    .command("shuffle")
    .description("Toggle or set shuffle mode")
    .addArgument(new Argument("[state]", "on or off; toggles when omitted").choices(["on", "off"]))
    .action(async (state?: "on" | "off") => {
      const engine = getEngine();
      const enabled = state === undefined ? !(await engine.getShuffle()) : state === "on";
      await engine.setShuffle(enabled);
      outputAction(mode(), { shuffle: enabled }, `Shuffle ${enabled ? "on" : "off"}`);
    });

  program
    .command("repeat")
    .description("Get or set repeat mode")
    .addArgument(new Argument("[mode]", "off, one, or all").choices(["off", "one", "all"]))
    .action(async (repeat?: RepeatMode) => {
      if (repeat === undefined) {
        outputValue(mode(), "repeat", await getEngine().getRepeat(), "Repeat");
        return;
      }
      await getEngine().setRepeat(repeat);
      outputAction(mode(), { repeat }, `Repeat: ${repeat}`);
    });
}
