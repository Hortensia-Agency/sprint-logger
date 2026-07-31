import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  minify: true,
  treeshake: true,
  sourcemap: true,
  target: "node18",
  // @sprint-logger/node is a real runtime dependency resolved from the host's
  // node_modules — never inline it, or a host that also installs it directly
  // ends up with two copies holding two separate `config` singletons (the
  // wrapper would init one and captureException() the other, silently no-op).
  external: ["@sprint-logger/node"],
});
