import { defineConfig } from "tsup";

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
    sourcemap: true,
    target: "node18",
  },
]);
