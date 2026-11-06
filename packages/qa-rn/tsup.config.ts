import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "tsup";

const OUTPUTS = ["dist/index.js", "dist/index.cjs"];

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // The app's bundler minifies; a minified build also renames require.
  minify: false,
  treeshake: true,
  sourcemap: true,
  target: "es2020",
  // Host-provided runtimes — never bundle them; resolve at the consumer.
  external: [
    "react",
    "react-native",
    "react-native-gesture-handler",
    "react-native-reanimated",
    "react-native-view-shot",
    "@react-native-async-storage/async-storage",
  ],
  // esbuild routes require() in ES modules through a __require helper, and
  // Metro only bundles modules named in a literal require("…"). Without this,
  // no optional peer (expo-web-browser, expo-crypto, expo-audio, view-shot…)
  // ever reaches the app, and the widget silently leaves those features out.
  async onSuccess() {
    for (const file of OUTPUTS) {
      const code = readFileSync(file, "utf8");
      writeFileSync(file, code.replace(/\b__require\((["'])/g, "require($1"));
    }
  },
});
