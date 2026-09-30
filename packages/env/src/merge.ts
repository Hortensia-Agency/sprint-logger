import type { Pulled, PullSource } from "./pull.ts";

export type ExplainSource = "shell" | "file" | PullSource;

/** One line of `--explain`. Has no value field, so a value cannot be printed. */
export interface ExplainRow {
  key: string;
  source: ExplainSource;
  kind: string;
  reason?: string;
}

export interface Merged {
  inject: Record<string, string>;
  rows: ExplainRow[];
  /** Machine keys kept from the shell because of --preserve-env. */
  preserved: string[];
}

/**
 * Decide what reaches the child process.
 *
 * Personal (dev) token: shell > local env files > the developer's override >
 * the shared value. Local always wins, the way dotenv and Next already behave.
 *
 * Machine token: Sprint wins over the shell, so a stale container variable
 * cannot silently shadow the vault. `--preserve-env` is the explicit opt-out
 * per key. Env files are ignored: the injected value is already in the
 * environment, and frameworks never let a file override it.
 */
export function mergeEnv(args: {
  pulled: Pulled;
  shell: Record<string, string | undefined>;
  fileKeys: Set<string>;
  preserve: Set<string>;
}): Merged {
  const personal = args.pulled.tokenKind === "personal";
  const inject: Record<string, string> = {};
  const rows: ExplainRow[] = [];
  const preserved: string[] = [];

  for (const v of args.pulled.vars) {
    const inShell = args.shell[v.key] !== undefined;
    const row = (source: ExplainSource): ExplainRow => ({
      key: v.key,
      source,
      kind: v.kind,
      ...(v.reason ? { reason: v.reason } : {}),
    });

    if (personal && inShell) {
      rows.push(row("shell"));
    } else if (personal && args.fileKeys.has(v.key)) {
      rows.push(row("file"));
    } else if (!personal && inShell && args.preserve.has(v.key)) {
      rows.push(row("shell"));
      preserved.push(v.key);
    } else {
      if (v.value !== undefined) inject[v.key] = v.value;
      rows.push(row(v.source));
    }
  }
  return { inject, rows, preserved };
}

export function formatExplain(rows: ExplainRow[]): string {
  const header: [string, string, string] = ["KEY", "SOURCE", "KIND"];
  const lines = rows.map((r): [string, string, string] => [r.key, r.source, r.kind]);
  const w0 = Math.max(header[0].length, ...lines.map((l) => l[0].length));
  const w1 = Math.max(header[1].length, ...lines.map((l) => l[1].length));
  return [header, ...lines]
    .map(([k, s, kind]) => `${k.padEnd(w0)}  ${s.padEnd(w1)}  ${kind}`)
    .join("\n");
}
