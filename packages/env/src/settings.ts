import { readLocalEnv } from "./env-file.ts";
import { tokenKind, type TokenKind } from "./pull.ts";

export interface Settings {
  token: string;
  kind: TokenKind;
  apiUrl: string;
  certPin?: string;
  /** Set when the token was read from a file usually committed to git. */
  committedFile?: string;
}

export class SettingsError extends Error {}

const KEYS = ["SPRINT_TOKEN", "SPRINT_SERVICE_TOKEN", "SPRINT_API_URL", "SPRINT_CERT_PIN"] as const;

/**
 * Sprint's own settings come from the environment first, then from the local
 * env files, so a dev token can sit in .env.local like any other value.
 * Returns null when there is no token at all.
 */
export function resolveSettings(cwd: string, env: Record<string, string | undefined>): Settings | null {
  const files = KEYS.some((k) => !env[k]) ? readLocalEnv(cwd) : {};
  const get = (key: (typeof KEYS)[number]) => env[key] || files[key]?.value || undefined;

  const tokenKey = get("SPRINT_TOKEN") ? "SPRINT_TOKEN" : "SPRINT_SERVICE_TOKEN";
  const token = get(tokenKey);
  if (!token) return null;
  const kind = tokenKind(token);
  if (!kind) throw new SettingsError("SPRINT_TOKEN is not a Sprint token (expected sprint_dev_... or sprint_svc_...).");

  const file = env[tokenKey] ? undefined : files[tokenKey]?.file;
  return {
    token,
    kind,
    apiUrl: get("SPRINT_API_URL") || "https://sprint.hortensia-agency.com",
    certPin: get("SPRINT_CERT_PIN"),
    ...(file === ".env" || file === ".env.development" ? { committedFile: file } : {}),
  };
}

export function committedFileWarning(file: string): string {
  return `SPRINT_TOKEN is in ${file}, which projects often commit. Move it to .env.local.`;
}

/**
 * A Coolify build passes build variables as Dockerfile ARG lines, printed with
 * their values in the deploy log, unless the app's "Build secrets" setting is
 * BuildKit secrets, which also sets COOLIFY_BUILD_SECRETS_HASH on every RUN.
 */
export function buildArgLeakWarning(env: Record<string, string | undefined>, phase: string | null): string | null {
  if (phase !== "build" || !env.COOLIFY_RESOURCE_UUID || env.COOLIFY_BUILD_SECRETS_HASH) return null;
  return "SPRINT_TOKEN reached this Coolify build as a build argument, so the deploy log shows it. In the app's Environment Variables, set Build secrets to Docker BuildKit secrets.";
}
