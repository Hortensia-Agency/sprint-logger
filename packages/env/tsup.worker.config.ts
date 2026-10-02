import { defineConfig } from "tsup";

// The pull worker as one self-contained CommonJS file. The main build embeds
// it as a string (tsup.config.ts) so config() can run it with `node -e`: no
// sibling file to find once the loader is bundled (Next instrumentation,
// webpack) or copied without it (standalone output, multi-stage Docker images).
export default defineConfig({
  entry: { "pull-worker.embedded": "src/pull-worker.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node18",
  bundle: true,
  minify: true,
  outExtension: () => ({ js: ".cjs" }),
  outDir: "dist/.worker",
});
