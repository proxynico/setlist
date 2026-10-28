import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ExternalServiceError, ValidationError } from "./errors";
import { type CliConfig, ENGINE_NAMES, type EngineName } from "./types";

const CONFIG_DIR = join(homedir(), ".config", "setlist");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: CliConfig = {
  defaultEngine: "auto",
  storefront: "auto",
};

export function isEngineName(value: unknown): value is EngineName {
  return ENGINE_NAMES.some((name) => name === value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function parseConfig(raw: string, path: string): CliConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ValidationError(`Config file is invalid JSON: ${path}`, (err as Error).message);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError(`Config file must contain a JSON object: ${path}`);
  }

  const { defaultEngine = DEFAULT_CONFIG.defaultEngine, storefront = DEFAULT_CONFIG.storefront } = parsed as Record<
    string,
    unknown
  >;
  if (!isEngineName(defaultEngine)) {
    throw new ValidationError(`Invalid default engine in config: ${defaultEngine}`);
  }
  if (typeof storefront !== "string") {
    throw new ValidationError("Invalid storefront in config: expected a string");
  }

  return { defaultEngine, storefront };
}

export async function loadConfig(): Promise<CliConfig> {
  try {
    return parseConfig(await readFile(CONFIG_FILE, "utf-8"), CONFIG_FILE);
  } catch (err) {
    if (isMissingFile(err)) return { ...DEFAULT_CONFIG };
    if (err instanceof ValidationError) throw err;
    throw new ExternalServiceError(`Failed to read config from ${CONFIG_FILE}`, undefined, err);
  }
}

export async function updateConfig(changes: Partial<CliConfig>): Promise<CliConfig> {
  const config = { ...(await loadConfig()), ...changes };
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  } catch (err) {
    throw new ExternalServiceError(`Failed to save config to ${CONFIG_FILE}`, undefined, err);
  }
  return config;
}
