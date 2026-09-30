import { test } from "node:test";
import assert from "node:assert/strict";
import { formatExplain, mergeEnv } from "../src/merge.ts";
import type { Pulled, PulledVar, TokenKind } from "../src/pull.ts";

const VARS: PulledVar[] = [
  { key: "SHARED", kind: "static", source: "shared", value: "vault-shared" },
  { key: "MINE", kind: "static", source: "override", value: "vault-override" },
  { key: "NOPE", kind: "static", source: "none" },
  { key: "LATER", kind: "proxy", source: "error", reason: "not enabled" },
];

function merge(tokenKind: TokenKind, opts: { shell?: string[]; files?: string[]; preserve?: string[] } = {}) {
  const pulled: Pulled = { env: "dev", tokenKind, vars: VARS };
  return mergeEnv({
    pulled,
    shell: Object.fromEntries((opts.shell ?? []).map((k) => [k, "shell-value"])),
    fileKeys: new Set(opts.files ?? []),
    preserve: new Set(opts.preserve ?? []),
  });
}

const sources = (m: ReturnType<typeof merge>) => Object.fromEntries(m.rows.map((r) => [r.key, r.source]));

test("personal: vault values fill what is not defined locally", () => {
  const m = merge("personal");
  assert.deepEqual(m.inject, { SHARED: "vault-shared", MINE: "vault-override" });
  assert.deepEqual(sources(m), { SHARED: "shared", MINE: "override", NOPE: "none", LATER: "error" });
});

test("personal: the shell beats the vault, override included", () => {
  const m = merge("personal", { shell: ["SHARED", "MINE"] });
  assert.deepEqual(m.inject, {});
  assert.equal(sources(m).SHARED, "shell");
  assert.equal(sources(m).MINE, "shell");
});

test("personal: an env file beats the vault, the shell beats the file", () => {
  const m = merge("personal", { shell: ["MINE"], files: ["SHARED", "MINE"] });
  assert.deepEqual(m.inject, {});
  assert.deepEqual(sources(m), { SHARED: "file", MINE: "shell", NOPE: "none", LATER: "error" });
});

test("personal: --preserve-env changes nothing (local already wins)", () => {
  const m = merge("personal", { preserve: ["SHARED"] });
  assert.equal(m.inject.SHARED, "vault-shared");
  assert.deepEqual(m.preserved, []);
});

test("machine: the vault beats the shell and ignores env files", () => {
  const m = merge("machine", { shell: ["SHARED"], files: ["MINE"] });
  assert.deepEqual(m.inject, { SHARED: "vault-shared", MINE: "vault-override" });
  assert.equal(sources(m).SHARED, "shared");
});

test("machine: --preserve-env keeps listed shell keys and reports them", () => {
  const m = merge("machine", { shell: ["SHARED"], preserve: ["SHARED", "MINE"] });
  assert.deepEqual(m.inject, { MINE: "vault-override" });
  assert.equal(sources(m).SHARED, "shell");
  // MINE is listed but not in the shell, so the vault value still applies.
  assert.deepEqual(m.preserved, ["SHARED"]);
});

test("explain lists key, source and kind and never a value", () => {
  const out = formatExplain(merge("personal", { files: ["SHARED"] }).rows);
  assert.match(out, /^KEY\s+SOURCE\s+KIND$/m);
  assert.match(out, /^SHARED\s+file\s+static$/m);
  assert.match(out, /^LATER\s+error\s+proxy$/m);
  for (const v of ["vault-shared", "vault-override", "shell-value"]) assert.ok(!out.includes(v));
});
