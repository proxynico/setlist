import type { Command } from "commander";
import type { MusicEngine } from "../lib/types";
import { getOutputMode, outputDevices } from "../lib/output";

export function registerDeviceCommands(program: Command, getEngine: () => MusicEngine) {
  program
    .command("devices")
    .description("List AirPlay devices")
    .action(async () => {
      outputDevices(await getEngine().getDevices(), getOutputMode(program.opts()));
    });
}
