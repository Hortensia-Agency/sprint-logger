import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { localFileKeys } from "./env-file.ts";
import { mergeEnv, type ExplainRow } from "./merge.ts";
import { detectPhase } from "./phase.ts";
import type { Pulled } from "./pull.ts";
import { buildArgLeakWarning, committedFileWarning, resolveSettings, SettingsError } from "./settings.ts";

export type { ExplainRow } from "./merge.ts";

export interface ConfigOptions {
  /** Where the local env files are. Defaults to process.cwd(). */
  cwd?: string;
  /** @deprecated No effect since 0.3.1: the environment always wins. */
  preserveEnv?: string[];
  /** Throw when there is no token instead of keeping the existing environment. Also SPRINT_ENV_REQUIRED=true. */
  required?: boolean;
}

type WorkerResult = { ok: true; pulled: Pulled } | { ok: false; reason: "rejected" | "unavailable"; message: string };

// Set in process.env once loaded, so a second import and every child process
// (which inherits the values) skip the fetch.
const LOADED = "SPRINT_ENV_LOADED";

// The published build inlines the worker's source (tsup.config.ts), so it runs
// with `node -e` and needs no file next to this one: bundlers and Next's
// standalone output don't copy a file that's only spawned by path. Running
// from source (tests), the worker file is right here.
declare const __SPRINT_PULL_WORKER__: string | undefined;

function workerArgs(): string[] {
  if (typeof __SPRINT_PULL_WORKER__ === "string") return ["-e", __SPRINT_PULL_WORKER__];
  // Through a variable: bundlers treat `new URL("<literal>", import.meta.url)`
  // as an asset to bundle, and this file only exists next to the source.
  const source = "./pull-worker.ts";
  return [fileURLToPath(new URL(source, import.meta.url))];
}

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
    SPRINT_PULL_PHASE: detectPhase(process.env, process.argv) ?? undefined,
  };
  // An --inspect or --require meant for the app must not run in the fetcher.
  delete env.NODE_OPTIONS;
  try {
    const out = execFileSync(process.execPath, workerArgs(), {
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
 * Keys already in process.env win, and with a dev token so do the local .env
 * files. Dev token: if Sprint is down it warns and returns. Machine token: any
 * failure throws, so a server never starts half-configured. No token:
 * warns and keeps the existing environment, in production too, unless
 * `required` / SPRINT_ENV_REQUIRED=true, where it throws.
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
    if (options.required ?? process.env.SPRINT_ENV_REQUIRED === "true") {
      throw new Error("@sprint-logger/env: SPRINT_TOKEN is not set and SPRINT_ENV_REQUIRED is on. Add the project's machine token to the host's environment.");
    }
    process.stderr.write("@sprint-logger/env: SPRINT_TOKEN is not set, so no Sprint secrets were loaded; using the existing environment.\n");
    return null;
  }
  if (settings.committedFile) process.stderr.write(`@sprint-logger/env: ${committedFileWarning(settings.committedFile)}\n`);
  const leak = buildArgLeakWarning(process.env, detectPhase(process.env, process.argv));
  if (leak) process.stderr.write(`@sprint-logger/env: ${leak}\n`);

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
  });
  Object.assign(process.env, merged.inject, { [LOADED]: "1" });
  for (const row of merged.rows) {
    if (row.source === "error") {
      process.stderr.write(`@sprint-logger/env: ${row.key} was not loaded: ${row.reason ?? "unavailable"}\n`);
    }
  }
  return merged.rows;
}
