import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Built first by tsup.worker.config.ts (see the build script).
const workerSource = readFileSync("dist/.worker/pull-worker.embedded.cjs", "utf8");

export default defineConfig([
  {
    entry: ["src/cli.ts", "src/pull-worker.ts"],
    format: ["esm"],
    sourcemap: true,
    target: "node18",
  },
  {
    // CommonJS too, so a require()-ing next.config.js or Next's transpiled
    // next.config.ts can load it.
    entry: ["src/index.ts", "src/config.ts"],
    format: ["esm", "cjs"],
    dts: true,
    shims: true,
    define: { __SPRINT_PULL_WORKER__: JSON.stringify(workerSource) },
    sourcemap: true,
    target: "node18",
  },
]);
