import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { localFileKeys } from "./env-file.ts";
import { mergeEnv, type ExplainRow } from "./merge.ts";
import type { Pulled } from "./pull.ts";
import { committedFileWarning, resolveSettings, SettingsError } from "./settings.ts";

export type { ExplainRow } from "./merge.ts";

export interface ConfigOptions {
  /** Where the local env files are. Defaults to process.cwd(). */
  cwd?: string;
  /** Machine tokens only: keys the environment keeps even when Sprint defines them. */
  preserveEnv?: string[];
}

type WorkerResult = { ok: true; pulled: Pulled } | { ok: false; reason: "rejected" | "unavailable"; message: string };

// Set in process.env once loaded, so a second import and every child process
// (which inherits the values) skip the fetch.
const LOADED = "SPRINT_ENV_LOADED";

const WORKER = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./pull-worker.ts" : "./pull-worker.js", import.meta.url)
);

function warn(lines: string[]): void {
  const width = Math.max(...lines.map((l) => l.length));
  const bar = "─".repeat(width + 2);
  process.stderr.write(
    [`┌${bar}┐`, ...lines.map((l) => `│ ${l.padEnd(width)} │`), `└${bar}┘`, ""].join("\n")
  );
}

function fetchSync(settings: { token: string; apiUrl: string; certPin?: string }): WorkerResult {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SPRINT_TOKEN: settings.token,
    SPRINT_API_URL: settings.apiUrl,
    SPRINT_CERT_PIN: settings.certPin,
  };
  // An --inspect or --require meant for the app must not run in the fetcher.
  delete env.NODE_OPTIONS;
  try {
    const out = execFileSync(process.execPath, [WORKER], {
      env,
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
    });
    return JSON.parse(out) as WorkerResult;
  } catch (err) {
    return { ok: false, reason: "unavailable", message: `Sprint could not be reached (${(err as Error).message}).` };
  }
}

/**
 * Load the project's Sprint secrets into process.env, synchronously, the way
 * dotenv's config() loads a file. Call it before anything reads the
 * environment: at the top of next.config, vite.config, or the server entry.
 *
 * Dev token: keys already in process.env or the local .env files win; if Sprint
 * is down it warns and returns. Machine token: Sprint wins over process.env and
 * any failure throws, so a server never starts half-configured. No token:
 * returns, except under NODE_ENV=production, where it throws.
 *
 * Returns what was loaded and from where, never values; null when nothing was.
 */
export function config(options: ConfigOptions = {}): ExplainRow[] | null {
  if (process.env[LOADED] === "1") return null;
  const cwd = options.cwd ?? process.cwd();

  let settings;
  try {
    settings = resolveSettings(cwd, process.env);
  } catch (err) {
    if (err instanceof SettingsError) throw new Error(`@sprint-logger/env: ${err.message}`);
    throw err;
  }
  if (!settings) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("@sprint-logger/env: SPRINT_TOKEN is not set. Add the project's machine token to the host's environment.");
    }
    process.stderr.write("@sprint-logger/env: SPRINT_TOKEN is not set, so no Sprint secrets were loaded. Add your dev token to .env.local.\n");
    return null;
  }
  if (settings.committedFile) process.stderr.write(`@sprint-logger/env: ${committedFileWarning(settings.committedFile)}\n`);

  const result = fetchSync(settings);
  if (!result.ok) {
    if (result.reason === "unavailable" && settings.kind === "personal") {
      warn(["Sprint secrets were not loaded.", result.message, "Starting with your local values only."]);
      return null;
    }
    throw new Error(`@sprint-logger/env: ${result.message}`);
  }

  const merged = mergeEnv({
    pulled: result.pulled,
    shell: process.env,
    fileKeys: result.pulled.tokenKind === "personal" ? localFileKeys(cwd) : new Set(),
    preserve: new Set(options.preserveEnv ?? process.env.SPRINT_PRESERVE_ENV?.split(",").map((k) => k.trim()) ?? []),
  });
  Object.assign(process.env, merged.inject, { [LOADED]: "1" });
  for (const key of merged.preserved) {
    process.stderr.write(`@sprint-logger/env: keeping ${key} from the environment (preserveEnv)\n`);
  }
  for (const row of merged.rows) {
    if (row.source === "error") {
      process.stderr.write(`@sprint-logger/env: ${row.key} was not loaded: ${row.reason ?? "unavailable"}\n`);
    }
  }
  return merged.rows;
}
