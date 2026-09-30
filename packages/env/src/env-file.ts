import { readFileSync } from "node:fs";
import { join } from "node:path";

// The files Next.js, Vite and dotenv-flow load in development. A key defined in
// any of them is the developer's own value and beats Sprint's.
export const DEV_ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];

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

/** Keys defined in the dev env files in `cwd`. Missing files are skipped. */
export function localFileKeys(cwd: string): Set<string> {
  const keys = new Set<string>();
  for (const name of DEV_ENV_FILES) {
    let src: string;
    try {
      src = readFileSync(join(cwd, name), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const key of Object.keys(parseEnvFile(src))) keys.add(key);
  }
  return keys;
}
