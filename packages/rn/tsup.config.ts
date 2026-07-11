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
  // Host-provided / host-installed runtimes — never bundle their code into this
  // SDK; the consumer's Metro graph resolves the static `import`s at build time.
  // These MUST stay external AND be imported statically in src (not via runtime
  // require) — a runtime `require()` gets rewritten by esbuild into a
  // dynamic-require Proxy shim that Metro cannot statically resolve, crashing the
  // host at launch with `Requiring unknown module "react-native"`.
  external: [
    "react-native",
    "expo-device",
    "@react-native-async-storage/async-storage",
  ],
});
