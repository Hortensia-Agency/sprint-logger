/**
 * SprintQa configuration + the three-layer prod guard, ported from the web SDK.
 *
 *   L0  build flag — the host only mounts <SprintQaWidget> when its own
 *       EXPO_PUBLIC_ENABLE_SPRINT_QA env is "true". This file can't enforce
 *       L0 (it lives in the host build), but `enabledByHost` carries the
 *       host's decision so the provider can no-op.
 *   L1  runtime config — GET /api/widget/config must return { enabled:true }.
 *   L2  host match — the running host (bundle id / configured host string)
 *       must match one of config.qaUrls. Native has no location.hostname, so
 *       the host passes its identifier explicitly via `host`.
 *   L3  identity — a mobile_widget PAT in the Authorization header. No cookie,
 *       no iframe probe (impossible on native).
 */

export interface SprintQaConfig {
  /** Public widget key, `pk_qa_…`. Tenant selector; safe to ship. */
  widgetKey: string;
  /**
   * The mobile_widget PAT (`sprint_pat_…`) the tester pasted in. May be null
   * before the tester has entered it — the widget then shows a paste prompt.
   */
  pat: string | null;
  /**
   * Sprint origin, e.g. https://sprint.hortensia-agency.com. Defaults to the
   * production host. Override only for local/staging Sprint.
   */
  origin?: string;
  /**
   * The host identifier matched against config.qaUrls (L2). On web this was
   * location.hostname; on native pass the value registered in the project's
   * qa_urls (commonly the app's bundle id or a logical host name).
   */
  host: string;
  /** L0: the host's build-flag decision. When false the widget never mounts. */
  enabledByHost?: boolean;
}

export const DEFAULT_ORIGIN = "https://sprint.hortensia-agency.com";

export function resolveOrigin(cfg: SprintQaConfig): string {
  return (cfg.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
}

/** L0 — host build flag. */
export function passesL0(cfg: SprintQaConfig): boolean {
  return cfg.enabledByHost !== false;
}

/** L2 — host must appear in the project's qa_urls. Mirrors the server rule. */
export function hostMatches(host: string, qaUrls: string[]): boolean {
  const h = host.trim().toLowerCase();
  return qaUrls.some((u) => u.trim().toLowerCase() === h);
}

/**
 * Resolve the host backend's runtime config to an active widget key, or null
 * when the host has turned the widget off. Fail-safe: a null/undefined config
 * (e.g. fetch threw, or the backend env lacks the vars) → off. An explicit
 * `enabled:false` or an absent/blank key → off. This is the no-rebuild kill
 * switch's decision point.
 */
export function resolveHostKey(
  hostConfig: { widgetKey?: string | null; enabled?: boolean } | null | undefined
): string | null {
  if (!hostConfig) return null;
  if (hostConfig.enabled === false) return null;
  const key = hostConfig.widgetKey?.trim();
  if (!key) return null;
  return key;
}

const PAT_PREFIX = "sprint_pat_";

/** Cheap shape check before sending — mirror of lib/pat.ts isPatShape. */
export function isPatShape(s: string | null | undefined): s is string {
  return (
    typeof s === "string" &&
    s.startsWith(PAT_PREFIX) &&
    s.length === PAT_PREFIX.length + 32
  );
}
