// Loads uptime.yml: YAML parse, ${ENV} substitution, defaults merge, validation.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { formatPath } from "../monitors/schema.js";
import { appConfigSchema, type AppConfig } from "./schema.js";

export const DEFAULT_CONFIG_PATH = "./uptime.yml";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

/** Picks the config path: the --config flag, then UPTIME_CONFIG, then ./uptime.yml. */
export function resolveConfigPath(flag: string | undefined, env: Env = process.env): string {
  return flag ?? (env["UPTIME_CONFIG"] || DEFAULT_CONFIG_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replaces ${NAME} in every string of a parsed document; an unset variable throws naming it. */
export function substituteEnv(value: unknown, env: Env): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = env[name];
      if (replacement === undefined) {
        throw new ConfigError(`environment variable ${name} is not set`);
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((item) => substituteEnv(item, env));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteEnv(item, env)]));
  }
  return value;
}

function mergeDefaults(document: Record<string, unknown>): Record<string, unknown> {
  const defaults = document["defaults"];
  const monitors = document["monitors"];
  if (!isRecord(defaults) || !Array.isArray(monitors)) return document;
  const merged = monitors.map((monitor) => {
    if (!isRecord(monitor)) return monitor;
    const own = monitor["thresholds"];
    const mergeable = own === undefined || isRecord(own);
    const thresholds = mergeable && (isRecord(defaults["thresholds"]) || isRecord(own))
      ? { ...(isRecord(defaults["thresholds"]) ? defaults["thresholds"] : {}), ...(isRecord(own) ? own : {}) }
      : undefined;
    return { ...defaults, ...monitor, ...(thresholds ? { thresholds } : {}) };
  });
  return { ...document, monitors: merged };
}

/** Parses config text into an AppConfig, throwing ConfigError with readable messages. */
export function parseConfig(text: string, env: Env = process.env): AppConfig {
  let document: unknown;
  try {
    document = parse(text) ?? {};
  } catch (error) {
    throw new ConfigError(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(document)) throw new ConfigError("the config file must be a YAML mapping");
  const substituted = substituteEnv(document, env);
  if (!isRecord(substituted)) throw new ConfigError("the config file must be a YAML mapping");
  const result = appConfigSchema.safeParse(mergeDefaults(substituted));
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = formatPath(issue.path);
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new ConfigError(`invalid config:\n${lines.map((line) => `  ${line}`).join("\n")}`);
  }
  return result.data;
}

/** Reads and validates the config file at `path`. */
export function loadConfig(path: string = resolveConfigPath(undefined), env: Env = process.env): AppConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`cannot read config file ${path}: ${reason}`);
  }
  return parseConfig(text, env);
}
