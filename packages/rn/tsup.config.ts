import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  minify: true,
  treeshake: true,
  sourcemap: true,
  target: "es2020",
  // Host-provided runtimes — never bundle them; resolve at the consumer.
  external: [
    "react-native",
    "expo-device",
    "@react-native-async-storage/async-storage",
  ],
});
