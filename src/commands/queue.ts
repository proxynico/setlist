import type { Command } from "commander";
import { UnsupportedOperationError } from "../lib/errors";

export function registerQueueCommands(program: Command) {
  const queue = program.command("queue").alias("q").description("Queue management (not supported yet)");

  queue
    .command("add <trackId>")
    .description("Add a track to the queue by its ID")
    .action(async () => {
      throw new UnsupportedOperationError(
        "Queue management is not implemented reliably for Music.app.",
        "The previous implementation interrupted playback. Use `setlist play <query>` for now instead of `queue add`.",
      );
    });
}
