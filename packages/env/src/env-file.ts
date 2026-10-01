import { readFileSync } from "node:fs";
import { join } from "node:path";

// dotenv's line grammar (lib/main.js, v17), copied verbatim so a key the
// framework will load is exactly a key this loader skips.
const LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

export function parseEnvFile(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = src.replace(/\r\n?/gm, "\n");
  LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINE.exec(lines)) != null) {
    let value = (match[2] || "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    out[match[1]] = value;
  }
  return out;
}

/**
 * Values from the env files Next.js, Vite and dotenv-flow load in development,
 * with the file each came from. A key defined here is the developer's own value
 * and beats Sprint's. Missing files are skipped.
 */
export function readLocalEnv(cwd: string): Record<string, { value: string; file: string }> {
  const out: Record<string, { value: string; file: string }> = {};
  // Lowest priority first, so a later file overwrites: Next's order.
  for (const name of [".env", ".env.development", ".env.local", ".env.development.local"]) {
    let src: string;
    try {
      src = readFileSync(join(cwd, name), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const [key, value] of Object.entries(parseEnvFile(src))) out[key] = { value, file: name };
  }
  return out;
}

/** Keys defined in the dev env files in `cwd`. */
export function localFileKeys(cwd: string): Set<string> {
  return new Set(Object.keys(readLocalEnv(cwd)));
}
