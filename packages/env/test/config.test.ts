import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INDEX = new URL("../src/index.ts", import.meta.url).href;
const DEV = "sprint_dev_" + "d".repeat(43);
const SVC = "sprint_svc_" + "s".repeat(43);
const REVOKED = "sprint_dev_" + "r".repeat(43);

const BODY = {
  personal: {
    env: "dev",
    tokenKind: "personal",
    vars: [
      { key: "FOO", kind: "static", source: "shared", value: "vault-foo" },
      { key: "BAR", kind: "static", source: "shared", value: "vault-bar" },
      { key: "MINE", kind: "static", source: "override", value: "vault-mine" },
      { key: "NOPE", kind: "static", source: "none" },
    ],
  },
  machine: {
    env: "prd",
    tokenKind: "machine",
    vars: [
      { key: "FOO", kind: "static", source: "shared", value: "vault-foo" },
      { key: "BAR", kind: "static", source: "shared", value: "vault-bar" },
    ],
  },
};

let server: Server;
let apiUrl: string;
let downUrl: string;
let requests = 0;
let lastPhase: string | null = null;

before(async () => {
  server = createServer((req, res) => {
    requests++;
    const auth = req.headers.authorization ?? "";
    const body = auth === `Bearer ${DEV}` ? BODY.personal : auth === `Bearer ${SVC}` ? BODY.machine : null;
    const url = new URL(req.url ?? "", "http://x");
    lastPhase = url.searchParams.get("phase");
    if (url.pathname !== "/api/env/pull" || !body) return void res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  downUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  await new Promise((r) => probe.close(r));
});

after(() => new Promise((r) => server.close(r)));

/**
 * Runs `body` in a fresh process with config() imported. Async on purpose: the
 * mock server lives in this process and must keep answering.
 */
function run(body: string, opts: { env?: Record<string, string>; files?: Record<string, string> } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "sprint-env-config-"));
  for (const [name, src] of Object.entries(opts.files ?? {})) writeFileSync(join(cwd, name), src);
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", `import { config } from ${JSON.stringify(INDEX)};\n${body}`],
    { cwd, env: { PATH: process.env.PATH ?? "", ...opts.env } }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  );
}

const PRINT = `process.stdout.write(JSON.stringify({ rows, FOO: process.env.FOO, BAR: process.env.BAR, MINE: process.env.MINE, NOPE: process.env.NOPE }));`;

test("dev token from .env.local: loads what the files and env don't define", async () => {
  const r = await run(`const rows = config();\n${PRINT}`, {
    env: { SPRINT_API_URL: apiUrl, BAR: "from-env" },
    files: { ".env.local": `SPRINT_TOKEN=${DEV}\nFOO=from-file\n` },
  });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  // FOO stays for the framework to load from .env.local; BAR keeps the env's value.
  assert.equal(out.FOO, undefined);
  assert.equal(out.BAR, "from-env");
  assert.equal(out.MINE, "vault-mine");
  assert.equal(out.NOPE, undefined);
  assert.deepEqual(
    out.rows.map((row: { key: string; source: string }) => `${row.key}:${row.source}`),
    ["FOO:file", "BAR:shell", "MINE:override", "NOPE:none"]
  );
  assert.ok(!JSON.stringify(out.rows).includes("vault-"), "rows carry no values");
});

test("loads once per process tree", async () => {
  const before = requests;
  const r = await run(`config(); const rows = config();\n${PRINT}`, { env: { SPRINT_API_URL: apiUrl, SPRINT_TOKEN: DEV } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).rows, null);
  assert.equal(requests - before, 1);
});

test("machine token: Sprint beats the env unless preserveEnv", async () => {
  const env = { SPRINT_API_URL: apiUrl, SPRINT_TOKEN: SVC, FOO: "stale", BAR: "stale" };
  const plain = await run(`const rows = config();\n${PRINT}`, { env });
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual([JSON.parse(plain.stdout).FOO, JSON.parse(plain.stdout).BAR], ["vault-foo", "vault-bar"]);

  const kept = await run(`const rows = config({ preserveEnv: ["FOO"] });\n${PRINT}`, { env });
  assert.deepEqual([JSON.parse(kept.stdout).FOO, JSON.parse(kept.stdout).BAR], ["stale", "vault-bar"]);
  assert.match(kept.stderr, /keeping FOO from the environment/);
});

test("Sprint down: a dev token warns and continues, a machine token throws", async () => {
  const dev = await run(`const rows = config();\n${PRINT}`, { env: { SPRINT_API_URL: downUrl, SPRINT_TOKEN: DEV } });
  assert.equal(dev.code, 0, dev.stderr);
  assert.equal(JSON.parse(dev.stdout).rows, null);
  assert.match(dev.stderr, /Sprint secrets were not loaded\./);

  const machine = await run(`config();`, { env: { SPRINT_API_URL: downUrl, SPRINT_TOKEN: SVC } });
  assert.equal(machine.code, 1);
  assert.match(machine.stderr, /unreachable/);
});

test("a rejected token throws", async () => {
  const r = await run(`config();`, { env: { SPRINT_API_URL: apiUrl, SPRINT_TOKEN: REVOKED } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rejected the token/);
});

test("no token: warns in development, throws in production", async () => {
  const dev = await run(`const rows = config();\n${PRINT}`);
  assert.equal(dev.code, 0, dev.stderr);
  assert.match(dev.stderr, /SPRINT_TOKEN is not set/);

  const prod = await run(`config();`, { env: { NODE_ENV: "production" } });
  assert.equal(prod.code, 1);
  assert.match(prod.stderr, /machine token/);
});

test("a token in .env gets a move-it warning", async () => {
  const r = await run(`config();`, { env: { SPRINT_API_URL: apiUrl }, files: { ".env": `SPRINT_TOKEN=${DEV}\n` } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /SPRINT_TOKEN is in \.env.*Move it to \.env\.local/);
});

test("sends the phase it detects, so Sprint can leave out build-only or run-time-only variables", async () => {
  const r = await run(`const rows = config();\n${PRINT}`, {
    env: { SPRINT_API_URL: apiUrl, SPRINT_TOKEN: SVC, SPRINT_PHASE: "build" },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastPhase, "build");
  const plain = await run(`const rows = config();\n${PRINT}`, { env: { SPRINT_API_URL: apiUrl, SPRINT_TOKEN: SVC } });
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(lastPhase, null);
});
