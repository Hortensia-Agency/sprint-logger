import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const DEV = "sprint_dev_" + "d".repeat(43);
const SVC = "sprint_svc_" + "s".repeat(43);
const REVOKED = "sprint_dev_" + "r".repeat(43);

const VALUES = ["vault-foo-value", "vault-bar-value", "vault-mine-value"];
const BODY = {
  personal: {
    env: "dev",
    tokenKind: "personal",
    vars: [
      { key: "FOO", kind: "static", source: "shared", value: VALUES[0] },
      { key: "BAR", kind: "static", source: "shared", value: VALUES[1] },
      { key: "MINE", kind: "static", source: "override", value: VALUES[2] },
      { key: "HIDDEN_KEY", kind: "proxy", source: "error", reason: "The credential proxy is not enabled yet." },
      { key: "NOPE", kind: "static", source: "none" },
    ],
  },
  machine: {
    env: "prd",
    tokenKind: "machine",
    vars: [
      { key: "FOO", kind: "static", source: "shared", value: VALUES[0] },
      { key: "BAR", kind: "static", source: "shared", value: VALUES[1] },
    ],
  },
};

let server: Server;
let apiUrl: string;
let downUrl: string;

before(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const body = auth === `Bearer ${DEV}` ? BODY.personal : auth === `Bearer ${SVC}` ? BODY.machine : null;
    if (req.url !== "/api/env/pull" || !body) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A port that was just free: nothing listens there.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  downUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  await new Promise((r) => probe.close(r));
});

after(() => new Promise((r) => server.close(r)));

// Prints the variables the child received, as JSON.
const PRINT_ENV =
  "process.stdout.write(JSON.stringify({FOO:process.env.FOO,BAR:process.env.BAR,MINE:process.env.MINE,NOPE:process.env.NOPE}))";

interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function start(args: string[], opts: { token?: string; url?: string; env?: Record<string, string>; cwd?: string } = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SPRINT_API_URL: opts.url ?? apiUrl,
    ...(opts.token ? { SPRINT_TOKEN: opts.token } : {}),
    ...opts.env,
  };
  return spawn(process.execPath, [CLI, ...args], { env, cwd: opts.cwd ?? mkdtempSync(join(tmpdir(), "sprint-env-cwd-")) });
}

function finish(child: ChildProcess): Promise<Result> {
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  return new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
}

const cli = (args: string[], opts?: Parameters<typeof start>[1]) => finish(start(args, opts));

test("dev token: env files and the shell win, the rest is injected", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sprint-env-cwd-"));
  writeFileSync(join(cwd, ".env.local"), "FOO=x\n");
  const r = await cli(["run", "--explain", "--", process.execPath, "-e", PRINT_ENV], {
    token: DEV,
    cwd,
    env: { BAR: "from-shell" },
  });
  assert.equal(r.code, 0, r.stderr);
  // FOO is left for the framework to load from .env.local.
  assert.deepEqual(JSON.parse(r.stdout), { BAR: "from-shell", MINE: VALUES[2] });
  assert.match(r.stderr, /^FOO\s+file\s+static$/m);
  assert.match(r.stderr, /^BAR\s+shell\s+static$/m);
  assert.match(r.stderr, /^MINE\s+override\s+static$/m);
  assert.match(r.stderr, /^NOPE\s+none\s+static$/m);
  assert.match(r.stderr, /HIDDEN_KEY was not loaded: The credential proxy is not enabled yet\./);
});

test("--explain and pull never print a value", async () => {
  const run = await cli(["run", "--explain", "--", process.execPath, "-e", ""], { token: DEV });
  const pullOut = await cli(["pull"], { token: DEV });
  assert.equal(pullOut.code, 0, pullOut.stderr);
  assert.match(pullOut.stdout, /^FOO\s+shared\s+static$/m);
  for (const out of [run.stdout, run.stderr, pullOut.stdout, pullOut.stderr]) {
    for (const v of VALUES) assert.ok(!out.includes(v), `leaked ${v}`);
  }
});

test("writes no file to the working directory or the temp directory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sprint-env-cwd-"));
  const tmp = mkdtempSync(join(tmpdir(), "sprint-env-tmp-"));
  const env = { TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const r = await cli(["run", "--", process.execPath, "-e", ""], { token: DEV, cwd, env });
  const p = await cli(["pull"], { token: SVC, cwd, env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(p.code, 0, p.stderr);
  assert.deepEqual(readdirSync(cwd), []);
  assert.deepEqual(readdirSync(tmp), []);
});

test("machine token: the shell beats the vault; --preserve-env is accepted and ignored", async () => {
  const shell = { FOO: "from-host" };
  const plain = await cli(["run", "--", process.execPath, "-e", PRINT_ENV], { token: SVC, env: shell });
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual(JSON.parse(plain.stdout), { FOO: "from-host", BAR: VALUES[1] });

  const old = await cli(["run", "--preserve-env=FOO", "--", process.execPath, "-e", PRINT_ENV], { token: SVC, env: shell });
  assert.equal(old.code, 0, old.stderr);
  assert.deepEqual(JSON.parse(old.stdout), { FOO: "from-host", BAR: VALUES[1] });
});

test("Sprint down: a dev token warns and starts, a machine token exits 1", async () => {
  const dev = await cli(["run", "--", process.execPath, "-e", "process.stdout.write('started')"], {
    token: DEV,
    url: downUrl,
  });
  assert.equal(dev.code, 0);
  assert.equal(dev.stdout, "started");
  assert.match(dev.stderr, /Sprint secrets were not loaded\./);

  const machine = await cli(["run", "--", process.execPath, "-e", "process.stdout.write('started')"], {
    token: SVC,
    url: downUrl,
  });
  assert.equal(machine.code, 1);
  assert.equal(machine.stdout, "");
  assert.match(machine.stderr, /unreachable/);
});

test("a rejected token exits 1 without starting the command", async () => {
  const r = await cli(["run", "--", process.execPath, "-e", "process.stdout.write('started')"], {
    token: REVOKED,
  });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /rejected the token/);
});

test("missing or foreign token exits 1", async () => {
  assert.equal((await cli(["run", "--", "true"])).code, 1);
  assert.equal((await cli(["run", "--", "true"], { token: "ghp_notours" })).code, 1);
});

test("passes the child's exit code through", async () => {
  const r = await cli(["run", "--", process.execPath, "-e", "process.exit(7)"], { token: DEV });
  assert.equal(r.code, 7);
});

test("forwards SIGTERM to the child and exits with its code", { skip: process.platform === "win32" }, async () => {
  const child = start(
    ["run", "--", process.execPath, "-e", "process.on('SIGTERM',()=>process.exit(42));process.stdout.write('ready');setInterval(()=>{},1000)"],
    { token: DEV }
  );
  const done = finish(child);
  await new Promise<void>((resolve) => {
    child.stdout!.on("data", (d: Buffer) => d.toString().includes("ready") && resolve());
  });
  child.kill("SIGTERM");
  const r = await done;
  assert.equal(r.code, 42);
});

test("re-raises the child's fatal signal", { skip: process.platform === "win32" }, async () => {
  const r = await cli(["run", "--", process.execPath, "-e", "process.kill(process.pid,'SIGKILL')"], { token: DEV });
  assert.equal(r.signal, "SIGKILL");
});
