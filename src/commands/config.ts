import { Argument, type Command } from "commander";
import { loadConfig, updateConfig } from "../lib/config";
import { ValidationError } from "../lib/errors";
import { getOutputMode, outputAction, outputJson, outputKeyValue, outputValue } from "../lib/output";
import { ENGINE_NAMES, type EngineName } from "../lib/types";

const STOREFRONT_PATTERN = /^[a-z]{2}$/;

export function registerConfigCommands(program: Command) {
  const mode = () => getOutputMode(program.opts());
  const config = program.command("config").description("Manage runtime defaults");

  config
    .command("status")
    .description("Show current defaults")
    .action(async () => {
      const current = await loadConfig();
      const output = mode();
      if (output === "json") {
        outputJson(current);
      } else if (output === "plain") {
        console.log(`default_engine\t${current.defaultEngine}`);
        console.log(`storefront\t${current.storefront}`);
      } else {
        outputKeyValue("Default engine", current.defaultEngine);
        outputKeyValue("Storefront", current.storefront);
      }
    });

  config
    .command("engine")
    .description("Get or set the default engine")
    .addArgument(new Argument("[engine]").choices(ENGINE_NAMES))
    .action(async (engine?: EngineName) => {
      if (!engine) {
        outputValue(mode(), "defaultEngine", (await loadConfig()).defaultEngine, "Default engine");
        return;
      }
      await updateConfig({ defaultEngine: engine });
      outputAction(mode(), { defaultEngine: engine }, `Default engine set to ${engine}`);
    });

  config
    .command("storefront [storefront]")
    .description("Get or set the Apple Music storefront (or use 'auto')")
    .action(async (storefront?: string) => {
      if (!storefront) {
        outputValue(mode(), "storefront", (await loadConfig()).storefront, "Storefront");
        return;
      }

      const normalized = storefront.toLowerCase();
      if (normalized !== "auto" && !STOREFRONT_PATTERN.test(normalized)) {
        throw new ValidationError("storefront must be 'auto' or a two-letter country code, e.g. us, gb, jp");
      }

      await updateConfig({ storefront: normalized });
      outputAction(mode(), { storefront: normalized }, `Storefront set to ${normalized}`);
    });
}
