import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPhase } from "../src/phase.ts";

const NODE = "/usr/bin/node";

test("SPRINT_PHASE wins", () => {
  assert.equal(detectPhase({ SPRINT_PHASE: "runtime", npm_lifecycle_event: "build" }, [NODE, "x"]), "runtime");
  assert.equal(detectPhase({ SPRINT_PHASE: "BUILD" }, [NODE, "server.js"]), "build");
});

test("the framework command decides", () => {
  assert.equal(detectPhase({}, [NODE, "/app/node_modules/next/dist/bin/next", "build"]), "build");
  assert.equal(detectPhase({}, [NODE, "/app/node_modules/next/dist/bin/next", "start", "-p", "3000"]), "runtime");
  assert.equal(detectPhase({}, [NODE, "/app/node_modules/vite/bin/vite.js", "--mode", "x", "build"]), "build");
  assert.equal(detectPhase({}, [NODE, "/app/node_modules/next/dist/bin/next", "dev"]), null);
  // `pnpm start` running `next build && next start` still pulls for the build in the build step.
  assert.equal(detectPhase({ npm_lifecycle_event: "start" }, [NODE, "/x/next", "build"]), "build");
});

test("a Next.js standalone server is runtime (node server.js)", () => {
  assert.equal(detectPhase({ __NEXT_PRIVATE_STANDALONE_CONFIG: "{}" }, [NODE, "/app/server.js"]), "runtime");
  assert.equal(detectPhase({ NEXT_RUNTIME: "nodejs" }, [NODE, "/app/server.js"]), null);
});

test("falls back to the package script", () => {
  assert.equal(detectPhase({ npm_lifecycle_event: "build" }, [NODE, "server.js"]), "build");
  assert.equal(detectPhase({ npm_lifecycle_event: "build:web" }, [NODE, "server.js"]), "build");
  assert.equal(detectPhase({ npm_lifecycle_event: "start" }, [NODE, "server.js"]), "runtime");
  assert.equal(detectPhase({ npm_lifecycle_event: "dev" }, [NODE, "server.js"]), null);
});

test("unknown means everything", () => {
  assert.equal(detectPhase({}, [NODE, "server.js"]), null);
  assert.equal(detectPhase({ SPRINT_PHASE: "whatever" }, [NODE, "server.js"]), null);
});
