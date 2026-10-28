import { type Command, Option } from "commander";
import { BROWSERS, type Browser, readMediaUserToken } from "../lib/cookies";
import { loadConfig } from "../lib/config";
import { clearMediaUserToken, getMediaUserToken, setMediaUserToken } from "../lib/secrets";
import { getOutputMode, outputAction, outputJson, outputKeyValue, outputMessage } from "../lib/output";

export function registerAuthCommands(program: Command) {
  const mode = () => getOutputMode(program.opts());
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("import")
    .description("Import media-user-token from a browser")
    .addOption(new Option("-b, --browser <browser>", "Browser to import from").choices(BROWSERS).default("safari"))
    .action(async (opts: { browser: Browser }) => {
      const token = await readMediaUserToken(opts.browser);
      await setMediaUserToken(token);
      outputAction(
        mode(),
        { success: true, browser: opts.browser, storedIn: "keychain", tokenLength: token.length },
        `Imported media-user-token from ${opts.browser} into Keychain`,
      );
    });

  auth
    .command("token <token>")
    .description("Manually set the media-user-token")
    .action(async (token: string) => {
      await setMediaUserToken(token);
      outputAction(
        mode(),
        { success: true, storedIn: "keychain", tokenLength: token.length },
        "Token saved to Keychain",
      );
    });

  auth
    .command("status")
    .description("Check authentication status")
    .action(async () => {
      const [config, token] = await Promise.all([loadConfig(), getMediaUserToken()]);
      const authenticated = Boolean(token);
      const output = mode();

      if (output === "json") {
        outputJson({
          authenticated,
          engine: config.defaultEngine,
          storefront: config.storefront,
          tokenStorage: authenticated ? "keychain" : null,
        });
      } else if (output === "plain") {
        console.log(["authenticated", authenticated, config.defaultEngine, config.storefront].join("\t"));
      } else if (authenticated) {
        outputMessage("Authenticated with Apple Music token in Keychain");
        outputKeyValue("Default engine", config.defaultEngine);
        outputKeyValue("Storefront", config.storefront);
      } else {
        outputKeyValue("Status", "Not authenticated (API engine unavailable)");
        outputKeyValue("Note", "Native engine works without authentication");
        outputKeyValue("Setup", "setlist auth import --browser safari");
      }
    });

  auth
    .command("clear")
    .description("Remove stored credentials")
    .action(async () => {
      await clearMediaUserToken();
      outputAction(mode(), { success: true }, "Credentials cleared from Keychain");
    });
}
