#!/usr/bin/env node
import { spawn } from "node:child_process";
import { localFileKeys } from "./env-file.ts";
import { formatExplain, mergeEnv, type Merged } from "./merge.ts";
import { detectPhase } from "./phase.ts";
import { pull, PullError } from "./pull.ts";
import { committedFileWarning, resolveSettings, SettingsError, type Settings } from "./settings.ts";

const USAGE = `sprint-env: load Sprint secrets into a command's environment

  sprint-env run [--explain] [--preserve-env=KEY,...] -- <command> [args...]
  sprint-env pull [--preserve-env=KEY,...]

run    starts <command> with the secrets in its environment. Nothing is written to disk.
pull   checks access and prints what run would load: key, source, kind. Never values.

--explain        print the same table to stderr before starting <command>
--preserve-env   machine tokens only: keep these keys from the current environment

Environment:
  SPRINT_TOKEN     a personal dev token (sprint_dev_...) or machine token (sprint_svc_...),
                   from the environment or the local .env files
  SPRINT_API_URL   defaults to https://sprint.hortensia-agency.com
  SPRINT_CERT_PIN  optional base64 sha256 of the server's public key
`;

function fail(message: string): never {
  process.stderr.write(`sprint-env: ${message}\n`);
  process.exit(1);
}

interface Args {
  cmd: "run" | "pull";
  explain: boolean;
  preserve: Set<string>;
  command: string[];
}

function parseArgs(argv: string[]): Args {
  const sep = argv.indexOf("--");
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  const [cmd, ...flags] = own;
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (cmd !== "run" && cmd !== "pull") {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const args: Args = { cmd, explain: false, preserve: new Set(), command };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--explain") {
      args.explain = true;
    } else if (flag === "--preserve-env" || flag.startsWith("--preserve-env=")) {
      const list = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : flags[++i];
      if (!list) fail("--preserve-env needs a comma-separated list of keys.");
      for (const key of list.split(",")) if (key.trim()) args.preserve.add(key.trim());
    } else {
      fail(`unknown option ${flag}. Put the command after --.`);
    }
  }
  if (cmd === "run" && command.length === 0) fail("usage: sprint-env run -- <command> [args...]");
  return args;
}

function config(): Settings {
  let settings: Settings | null;
  try {
    settings = resolveSettings(process.cwd(), process.env);
  } catch (err) {
    if (err instanceof SettingsError) fail(err.message);
    throw err;
  }
  if (!settings) fail("SPRINT_TOKEN is not set. Create a dev token on the project's Secrets page and add it to .env.local.");
  if (settings.committedFile) process.stderr.write(`sprint-env: ${committedFileWarning(settings.committedFile)}\n`);
  return settings;
}

function warnBox(lines: string[]): void {
  const width = Math.max(...lines.map((l) => l.length));
  const bar = "─".repeat(width + 2);
  process.stderr.write(
    [`┌${bar}┐`, ...lines.map((l) => `│ ${l.padEnd(width)} │`), `└${bar}┘`, ""].join("\n")
  );
}

function report(merged: Merged): void {
  for (const key of merged.preserved) {
    process.stderr.write(`sprint-env: keeping ${key} from the environment (--preserve-env)\n`);
  }
  for (const row of merged.rows) {
    if (row.source === "error") {
      process.stderr.write(`sprint-env: ${row.key} was not loaded: ${row.reason ?? "unavailable"}\n`);
    }
  }
}

async function load(args: Args): Promise<Merged | null> {
  const cfg = config();
  try {
    // `sprint-env run -- next build` pulls for the build; `pull` explains everything.
    const phase = args.cmd === "run" ? detectPhase(process.env, ["node", ...args.command]) : null;
    const pulled = await pull({ ...cfg, phase });
    return mergeEnv({
      pulled,
      shell: process.env,
      fileKeys: pulled.tokenKind === "personal" ? localFileKeys(process.cwd()) : new Set(),
      preserve: args.preserve,
    });
  } catch (err) {
    if (!(err instanceof PullError)) throw err;
    // A dev server still starts on local values when Sprint is down; a machine
    // must not start half-configured.
    if (err.reason === "unavailable" && cfg.kind === "personal" && args.cmd === "run") {
      warnBox([
        "Sprint secrets were not loaded.",
        err.message,
        "Starting with your shell and local .env files only.",
      ]);
      return null;
    }
    fail(err.message);
  }
}

function run(command: string[], inject: Record<string, string>): void {
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    // The marker stops an in-process config() from fetching a second time.
    env: { ...process.env, ...inject, SPRINT_ENV_LOADED: "1" },
    // npm/pnpm/yarn are .cmd shims on Windows and need a shell to start.
    shell: process.platform === "win32",
  });

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  for (const s of signals) process.on(s, forward);

  child.on("error", (err) => fail(`could not start ${command[0]}: ${err.message}`));
  child.on("exit", (code, signal) => {
    for (const s of signals) process.off(s, forward);
    if (signal) {
      // Die the same way the child did, so a parent sees the real cause.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const merged = await load(args);

  if (args.cmd === "pull") {
    report(merged!);
    process.stdout.write(formatExplain(merged!.rows) + "\n");
    return;
  }
  if (merged) {
    report(merged);
    if (args.explain) process.stderr.write(formatExplain(merged.rows) + "\n");
  }
  run(args.command, merged?.inject ?? {});
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
