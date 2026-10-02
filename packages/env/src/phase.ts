// Which phase this process is pulling for, so Sprint can leave out variables
// marked build-time-only or run-time-only. Null means "don't know" (or dev):
// the server then sends everything, which is also what older loaders get.
//
//   1. SPRINT_PHASE=build|runtime, when set, wins.
//   2. The framework's own command: `next build`, `vite build` → build;
//      `next start`, `vite preview` → runtime; `dev` → null.
//   3. A Next.js standalone server (`node server.js` sets
//      __NEXT_PRIVATE_STANDALONE_CONFIG before it starts): runtime. NEXT_RUNTIME
//      can't be used: Next substitutes it at build time, it isn't really set.
//   4. The package script: build / prebuild / build:* → build; start → runtime.

export type Phase = "build" | "runtime";

const TOOLS = new Set(["next", "vite", "astro", "nuxt", "nuxi", "remix", "react-router", "svelte-kit", "vinxi"]);

function fromCommand(argv: string[]): Phase | null | undefined {
  const i = argv.findIndex((a, n) => n > 0 && TOOLS.has(a.split(/[\\/]/).pop()!.replace(/\.(c|m)?js$/, "")));
  if (i === -1) return undefined;
  // The first recognised subcommand: flags and their values (`--mode x`) are skipped.
  for (const a of argv.slice(i + 1)) {
    if (a === "build" || a === "generate" || a === "export") return "build";
    if (a === "start" || a === "preview" || a === "serve") return "runtime";
    if (a === "dev") return null;
  }
  return undefined;
}

export function detectPhase(env: Record<string, string | undefined>, argv: string[]): Phase | null {
  const explicit = env.SPRINT_PHASE?.trim().toLowerCase();
  if (explicit === "build" || explicit === "runtime") return explicit;

  const command = fromCommand(argv);
  if (command !== undefined) return command;

  if (env.__NEXT_PRIVATE_STANDALONE_CONFIG) return "runtime";

  const script = env.npm_lifecycle_event;
  if (script && /^(pre|post)?build(:|$)/.test(script)) return "build";
  if (script && /^(pre|post)?start(:|$)/.test(script)) return "runtime";
  return null;
}
