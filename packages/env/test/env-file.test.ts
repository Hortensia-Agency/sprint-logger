import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localFileKeys, parseEnvFile } from "../src/env-file.ts";

// Expected values were produced by dotenv 17.4.2's parse() on the same input;
// @next/env bundles the same line grammar.
const DOTENV_PARITY: [string, Record<string, string>][] = [
  ["A=1\nB = two \n# comment\nC=", { A: "1", B: "two", C: "" }],
  ["export D=4\nexport  E='five'", { D: "4", E: "five" }],
  ['F="multi\nline"\nG=\'keep\\nraw\'\nH="esc\\nnl"', { F: "multi\nline", G: "keep\\nraw", H: "esc\nnl" }],
  ["I=val # trailing\nJ='q # not comment'\nK=\"x\" # c", { I: "val", J: "q # not comment", K: "x" }],
  ["L=`back`\nM:colon\nN: spaced", { L: "back", N: "spaced" }],
  ["dotted.key=1\ndash-key=2\n  indented=3", { "dotted.key": "1", "dash-key": "2", indented: "3" }],
  ["O='unterminated\nP=after", { O: "'unterminated", P: "after" }],
  ["Q=a=b=c\nR==x", { Q: "a=b=c", R: "=x" }],
  ['S="embedded \\"quote\\""', { S: 'embedded \\"quote\\"' }],
  ["CRLF=1\r\nCR2=2\rT=3", { CRLF: "1", CR2: "2", T: "3" }],
  ["=novalue\nU\nV=ok", { V: "ok" }],
  ["W=  spaced value  ", { W: "spaced value" }],
];

test("parses like dotenv", () => {
  for (const [src, expected] of DOTENV_PARITY) {
    assert.deepEqual(parseEnvFile(src), expected, JSON.stringify(src));
  }
});

test("collects keys from every dev env file and skips missing ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprint-env-files-"));
  writeFileSync(join(dir, ".env"), "A=1\n");
  writeFileSync(join(dir, ".env.local"), "export B=2\n");
  writeFileSync(join(dir, ".env.development.local"), "C='3'\n");
  writeFileSync(join(dir, ".env.production"), "PROD_ONLY=1\n");
  assert.deepEqual([...localFileKeys(dir)].sort(), ["A", "B", "C"]);
});
