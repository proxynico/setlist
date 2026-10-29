import type { Command } from "commander";
import { parseInteger } from "../lib/input";
import { getOutputMode, outputReplay } from "../lib/output";
import type { MusicEngine } from "../lib/types";

export function registerReplayCommand(program: Command, getEngine: () => MusicEngine) {
  program
    .command("replay [year]")
    .description("Your Apple Music Replay: hours listened, top songs, and the artists in them")
    .option("-l, --limit <n>", "Top songs and artists to show", "10")
    .action(async (year: string | undefined, opts: { limit: string }) => {
      const replay = await getEngine().getReplay(
        year === undefined ? undefined : parseInteger("year", year, { min: 1 }),
      );
      outputReplay(replay, getOutputMode(program.opts()), parseInteger("limit", opts.limit, { min: 1 }));
    });
}
