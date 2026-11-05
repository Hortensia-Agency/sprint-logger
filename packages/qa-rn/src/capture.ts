/**
 * Debug capture while a bug video records: console, network and screen
 * changes, the React Native counterpart of the web widget's qa-capture.js.
 *
 * There is no DOM to replay on a phone, so `events` stays empty and the
 * viewer in Sprint shows the telemetry tracks against the video's clock. The
 * entry shapes and the redaction rules are the web's (lib/qa/capture-redact.ts
 * in Sprint): auth headers always masked, sensitive query values and
 * token-shaped strings redacted, bodies never kept. Best-effort throughout: a
 * failure here only means the video ships without its sidecar.
 */

import { Platform } from "react-native";
import { gzipSync, strToU8 } from "fflate";
import type { SprintQaClient } from "./client";
import type { CaptureProfile } from "./contract";
import { FileSystem } from "./optional-deps";
import { putFile } from "./video";

const TELEMETRY_CAP = 5000;
const STRING_CAP = 2000;
const HEADER_VALUE_CAP = 1024;
const REDACTED = "•redacted•";
const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|x-session-token)$/i;
const SENSITIVE_PARAM =
  /(token|secret|password|passwd|pwd|api[-_]?key|apikey|auth|session|access[-_]?token|refresh[-_]?token|id[-_]?token|code|signature|sig)/i;
const TOKEN_LIKE = /(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}|[A-Za-z0-9_-]{32,})/g;

type Entry = { t: number; kind: "console" | "network" | "action"; [k: string]: unknown };

export interface CapturePayload {
  version: 2;
  startedAt: number;
  durationMs: number;
  truncated: boolean;
  eventCount: number;
  telemetryCount: number;
  meta: Record<string, unknown>;
  events: never[];
  telemetry: Entry[];
}

function redactTokens(s: string): string {
  return s.replace(TOKEN_LIKE, REDACTED);
}

function redactUrl(raw: string): string {
  const [base, query = ""] = raw.split("#")[0].split("?");
  if (!query) return base.slice(0, STRING_CAP);
  const parts = query.split("&").map((pair) => {
    const [k, v] = pair.split("=");
    return SENSITIVE_PARAM.test(decodeURIComponent(k ?? "")) && v !== undefined ? `${k}=${REDACTED}` : pair;
  });
  return `${base}?${parts.join("&")}`.slice(0, STRING_CAP);
}

function headers(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h || typeof h !== "object") return out;
  const add = (k: string, v: unknown) => {
    out[k] = SENSITIVE_HEADER.test(k) ? REDACTED : redactTokens(String(v)).slice(0, HEADER_VALUE_CAP);
  };
  const anyH = h as { forEach?: (fn: (v: string, k: string) => void) => void };
  if (typeof anyH.forEach === "function" && !Array.isArray(h)) anyH.forEach((v, k) => add(k, v));
  else for (const [k, v] of Object.entries(h as Record<string, unknown>)) add(k, v);
  return out;
}

function consoleArg(arg: unknown): string {
  let s: string;
  if (typeof arg === "string") s = arg;
  else if (arg instanceof Error) s = `${arg.name}: ${arg.message}`;
  else {
    try {
      s = JSON.stringify(arg);
    } catch {
      s = String(arg);
    }
  }
  return redactTokens(s ?? String(arg)).slice(0, STRING_CAP);
}

interface Session {
  t0: number;
  telemetry: Entry[];
  truncated: boolean;
  undo: (() => void)[];
}

let session: Session | null = null;

function push(e: Omit<Entry, "t">) {
  const s = session;
  if (!s) return;
  if (s.telemetry.length >= TELEMETRY_CAP) {
    s.truncated = true;
    return;
  }
  s.telemetry.push({ t: Date.now() - s.t0, ...e } as Entry);
}

/**
 * Starts recording. `ignoreOrigin` keeps the widget's own calls to Sprint out
 * of the network track; they are the report being sent, not the bug.
 */
export function startCapture(opts: { profile: CaptureProfile; ignoreOrigin: string }): void {
  if (session) return;
  const s: Session = { t0: Date.now(), telemetry: [], truncated: false, undo: [] };
  session = s;
  const ignored = (url: string) => url.startsWith(`${opts.ignoreOrigin}/api/widget`);

  const levels = ["log", "info", "warn", "error"] as const;
  for (const level of levels) {
    const orig = console[level];
    console[level] = (...args: unknown[]) => {
      try {
        push({ kind: "console", level, args: args.map(consoleArg) });
      } catch {
        // Never let the capture break the host's logging.
      }
      orig.apply(console, args);
    };
    s.undo.push(() => {
      console[level] = orig;
    });
  }

  const g = globalThis as { fetch?: typeof fetch; XMLHttpRequest?: typeof XMLHttpRequest };
  const origFetch = g.fetch;
  if (origFetch) {
    g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = (init?.method || (input as Request)?.method || "GET").toUpperCase();
      const started = Date.now();
      const base = { method, url: redactUrl(url), via: "fetch", type: "fetch-xhr", reqHeaders: headers(init?.headers) };
      return origFetch(input as RequestInfo, init).then(
        (res) => {
          if (!ignored(url)) {
            const resHeaders = headers(res.headers);
            push({
              kind: "network",
              data: {
                ...base,
                status: res.status,
                ms: Date.now() - started,
                resBytes: Number(resHeaders["content-length"]) || undefined,
                resHeaders,
              },
            });
          }
          return res;
        },
        (err) => {
          if (!ignored(url)) push({ kind: "network", error: true, data: { ...base, status: 0, ms: Date.now() - started } });
          throw err;
        }
      );
    }) as typeof fetch;
    s.undo.push(() => {
      g.fetch = origFetch;
    });
  }

  const XHR = g.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    type Tagged = XMLHttpRequest & { __sq?: { method: string; url: string; started: number } };
    XHR.prototype.open = function (this: Tagged, method: string, url: string | URL, ...rest: unknown[]) {
      this.__sq = { method: String(method).toUpperCase(), url: String(url), started: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (open as any).call(this, method, url, ...rest);
    } as typeof XHR.prototype.open;
    XHR.prototype.send = function (this: Tagged, body?: Document | XMLHttpRequestBodyInit | null) {
      const tag = this.__sq;
      if (tag && !ignored(tag.url)) {
        tag.started = Date.now();
        this.addEventListener("loadend", () => {
          push({
            kind: "network",
            ...(this.status === 0 ? { error: true } : {}),
            data: {
              method: tag.method,
              url: redactUrl(tag.url),
              status: this.status,
              ms: Date.now() - tag.started,
              via: "xhr",
              type: "fetch-xhr",
            },
          });
        });
      }
      return send.call(this, body ?? null);
    };
    s.undo.push(() => {
      XHR.prototype.open = open;
      XHR.prototype.send = send;
    });
  }
}

/** A screen change in the host app, the phone's closest thing to a click trail. */
export function captureNavigation(route: string): void {
  push({ kind: "action", action: "navigate", label: redactUrl(route) });
}

/** Ends recording and returns the payload once; null when nothing was recording. */
export function stopCapture(): CapturePayload | null {
  const s = session;
  if (!s) return null;
  session = null;
  for (const undo of s.undo.reverse()) {
    try {
      undo();
    } catch {
      // Restoring one hook must not stop the others.
    }
  }
  return {
    version: 2,
    startedAt: s.t0,
    durationMs: Date.now() - s.t0,
    truncated: s.truncated,
    eventCount: 0,
    telemetryCount: s.telemetry.length,
    meta: { platform: Platform.OS, osVersion: String(Platform.Version) },
    events: [],
    telemetry: s.telemetry,
  };
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

/**
 * Gzip, write to a cache file and stream it to storage, then link it to the
 * task and its video. Callers swallow the rejection: the report is filed.
 */
export async function uploadCapture(
  client: SprintQaClient,
  taskId: number,
  videoAttachmentId: number | undefined,
  capture: CapturePayload
): Promise<void> {
  if (!FileSystem?.cacheDirectory) return;
  const gz = gzipSync(strToU8(JSON.stringify(capture)));
  const path = `${FileSystem.cacheDirectory}sprint-qa-capture-${capture.startedAt}.json.gz`;
  await FileSystem.writeAsStringAsync(path, base64(gz), { encoding: FileSystem.EncodingType.Base64 });
  try {
    const presign = await client.presignCapture(taskId, gz.length);
    await putFile(presign.uploadUrl, path, "application/gzip");
    await client.recordCapture({
      taskId,
      captureObjectKey: presign.objectKey,
      videoAttachmentId,
      startedAtEpochMs: capture.startedAt,
      durationMs: capture.durationMs,
      eventCount: capture.eventCount,
      telemetryCount: capture.telemetryCount,
      truncated: capture.truncated,
    });
  } finally {
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
  }
}
