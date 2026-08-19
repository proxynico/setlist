import type { Command } from "commander";
import { importCookiesFromBrowser, SUPPORTED_BROWSERS } from "../lib/cookies";
import { clearMediaUserToken, getMediaUserToken, loadConfig, setMediaUserToken } from "../lib/config";
import { ValidationError } from "../lib/errors";
import { getOutputMode, outputJson, outputKeyValue, outputMessage } from "../lib/output";

export function registerAuthCommands(program: Command) {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("import")
    .description("Import media-user-token from a browser")
    .option("-b, --browser <browser>", `Browser to import from (${SUPPORTED_BROWSERS.join(", ")})`, "safari")
    .action(async (opts) => {
      const browser = opts.browser.toLowerCase();
      if (!SUPPORTED_BROWSERS.includes(browser)) {
        throw new ValidationError(`Unsupported browser: ${browser}. Use one of: ${SUPPORTED_BROWSERS.join(", ")}`);
      }

      const token = await importCookiesFromBrowser(browser);
      const mode = getOutputMode(program.opts());
      if (mode === "json") {
        outputJson({ success: true, browser, storedIn: "keychain", tokenLength: token.length });
      } else {
        outputMessage(`Imported media-user-token from ${browser} into Keychain`);
      }
    });

  auth
    .command("token <token>")
    .description("Manually set the media-user-token")
    .action(async (token: string) => {
      await setMediaUserToken(token);
      const mode = getOutputMode(program.opts());
      if (mode === "json") {
        outputJson({ success: true, storedIn: "keychain", tokenLength: token.length });
      } else {
        outputMessage("Token saved to Keychain");
      }
    });

  auth
    .command("status")
    .description("Check authentication status")
    .action(async () => {
      const config = await loadConfig();
      const token = await getMediaUserToken();
      const mode = getOutputMode(program.opts());
      const hasToken = !!token;

      if (mode === "json") {
        outputJson({
          authenticated: hasToken,
          engine: config.defaultEngine,
          storefront: config.storefront ?? "auto",
          tokenStorage: hasToken ? "keychain" : null,
        });
      } else if (mode === "plain") {
        console.log(`authenticated\t${hasToken}\t${config.defaultEngine}\t${config.storefront ?? "auto"}`);
      } else {
        if (hasToken) {
          outputMessage("Authenticated with Apple Music token in Keychain");
          outputKeyValue("Default engine", config.defaultEngine);
          outputKeyValue("Storefront", config.storefront ?? "auto");
        } else {
          outputKeyValue("Status", "Not authenticated (API engine unavailable)");
          outputKeyValue("Note", "Native engine works without authentication");
          outputKeyValue("Setup", "setlist auth import --browser safari");
        }
      }
    });

  auth
    .command("clear")
    .description("Remove stored credentials")
    .action(async () => {
      await clearMediaUserToken();
      const mode = getOutputMode(program.opts());
      if (mode === "json") {
        outputJson({ success: true });
      } else {
        outputMessage("Credentials cleared from Keychain");
      }
    });
}
